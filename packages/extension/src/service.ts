import {
  GraphStore,
  LockEngine,
  TsExtractor,
  buildFallbackEdges,
  searchNodes,
  expandSubgraph,
  allLayers,
  markStale,
  nodeToDto,
  estimateTokens,
  type CodeEdge,
  type CodeNode,
  type EditApplier,
  type GraphIndex,
  type GraphNodeDTO,
  type SourceEdit,
} from '@nodecode/core';
import { resolveImport } from '@nodecode/core';
import { runScan, type MetaProvider, type ScanResult } from '@nodecode/core';
import type { FileRegistry } from './types';

/**
 * The workspace graph service: core wired to the extension host.
 * Owns the GraphStore, incremental re-extraction and search.
 */
export class WorkspaceGraphService {
  readonly store: GraphStore;
  readonly locks: LockEngine;
  private extractors = new Map<string, TsExtractor>();
  /** Last-save hashes for tamper detection (extension-side, in-memory). */
  lastSeen = new Map<string, string>();
  /** Set while OUR saveEdit path is writing, so tamper checks skip it. */
  private ownWrites = new Set<string>();

  constructor(
    indexPath: string,
    private files: FileRegistry,
    private applier: EditApplier,
    private onGraphUpdated?: () => void
  ) {
    this.store = new GraphStore(indexPath);
    this.store.load();
    this.locks = new LockEngine();
    this.locks.attach(this.store.get());
  }

  private extractor(file: string): TsExtractor {
    let ex = this.extractors.get(file.endsWith('.tsx') ? 'tsx' : 'ts');
    if (!ex) {
      // separate extractor instances per grammar so parsers cache once
      ex = file.endsWith('.tsx') ? new TsExtractor() : new TsExtractor();
      this.extractors.set(file.endsWith('.tsx') ? 'tsx' : 'ts', ex);
    }
    return ex;
  }

  async extractFile(file: string): Promise<boolean> {
    const text = await this.files.read(file);
    if (text === null) return false;
    const hadOwnWrite = this.ownWrites.has(file);
    const ex = this.extractor(file);
    const fx = await ex.extract(file, text);
    const result = this.store.mergeFileExtraction(file, fx);
    this.recomputeEdgesForFile(fx);
    this.refreshTamperBaseline(file, text);
    return result.added.length + result.nodes.length + result.relinked.length > 0 || hadOwnWrite;
  }

  /**
   * Recompute LSP-less fallback edges for a file, plus merge existing index
   * edges whose endpoints still exist.
   */
  private recomputeEdgesForFile(fx: Awaited<ReturnType<TsExtractor['extract']>>): void {
    const single = new Map([[fx.file, fx]]);
    const io = { exists: (p: string) => this.files.exists(p) };
    const fresh = buildFallbackEdges(single, io);
    // cross-file edges: parse imported files' node lists lazily from index
    const index = this.store.get();
    const knownFiles = new Map<string, FileTomb>();
    for (const n of Object.values(index.nodes)) {
      let t = knownFiles.get(n.file);
      if (!t) {
        t = { symbols: new Map() };
        knownFiles.set(n.file, t);
      }
      t.symbols.set(n.symbolPath.split('.').pop()!, n.id);
    }
    const edges: CodeEdge[] = fresh;
    for (const spec of fx.imports) {
      const targetFile = resolveImport(fx.file, spec, io);
      if (!targetFile) continue;
      const t = knownFiles.get(targetFile);
      if (!t) continue;
      const specNames = Object.entries(fx.importSymbols)
        .filter(([, s]) => s === spec)
        .map(([local]) => local);
      for (const node of fx.nodes) {
        if (!node.id) continue;
        const ids = fx.refs[node.id] ?? [];
        for (const ident of ids) {
          if (specNames.includes(ident)) {
            const to = t.symbols.get(ident);
            if (to) edges.push({ from: node.id, to, type: 'imports' });
          }
        }
      }
    }
    this.store.upsertEdges(edges);
  }

  /** Scan or lazily register all files; incremental (only unknown/changed). */
  async ensureScanned(onProgress?: (done: number, total: number, file: string) => void): Promise<void> {
    const list = await this.files.list();
    const knownFiles = new Set(this.store.files());
    let done = 0;
    for (const file of list) {
      done++;
      if (!knownFiles.has(file) || (await this.fileChanged(file))) {
        await this.extractFile(file);
      }
      onProgress?.(done, list.length, file);
    }
    // drop nodes of files that no longer exist
    for (const f of [...knownFiles]) {
      if (!this.files.exists(f)) {
        this.store.mergeFileExtraction(f, { file: f, nodes: [], imports: [], importSymbols: {}, exports: {}, refs: {} });
      }
    }
    // mark metadata staleness after merge
    markStale(this.store.get());
    this.notifyGraph();
  }

  private async fileChanged(file: string): Promise<boolean> {
    const text = await this.files.read(file);
    if (text === null) return true;
    return this.lastSeen.get(file) !== text;
  }

  refreshTamperBaseline(file: string, text: string): void {
    this.lastSeen.set(file, text);
  }

  markOwnWrite(file: string): void {
    this.ownWrites.add(file);
    // cleared on next external read
    setTimeout(() => this.ownWrites.delete(file), 500);
  }

  notifyGraph(): void {
    this.onGraphUpdated?.();
  }

  // ---- read model -----------------------------------------------------------

  getGraph(): { nodes: GraphNodeDTO[]; edges: CodeEdge[]; layers: string[] } {
    const index = this.store.get();
    return {
      nodes: Object.values(index.nodes).map((n) => nodeToDto(n)),
      edges: index.edges,
      layers: allLayers(index),
    };
  }

  search(query: string, depth: number, layerFilter?: string[]): { nodes: GraphNodeDTO[]; edges: CodeEdge[]; layers: string[] } {
    const index = this.store.get();
    const hits = searchNodes(index, query, 25);
    if (hits.length === 0) {
      // graceful fallback: show everything matching nothing => overview empty
      return { nodes: [], edges: [], layers: allLayers(index) };
    }
    const roots = hits.map((h) => h.node.id);
    const sub = expandSubgraph(index, roots, depth, layerFilter);
    return {
      nodes: sub.nodes.map((n) => nodeToDto(n)),
      edges: sub.edges,
      layers: allLayers(index),
    };
  }

  expand(id: string, depth: number, layerFilter?: string[]): { nodes: GraphNodeDTO[]; edges: CodeEdge[]; layers: string[] } {
    const sub = expandSubgraph(this.store.get(), [id], depth, layerFilter);
    return {
      nodes: sub.nodes.map((n) => nodeToDto(n)),
      edges: sub.edges,
      layers: allLayers(this.store.get()),
    };
  }

  node(id: string): CodeNode | undefined {
    return this.store.node(id);
  }

  async readNodeSource(id: string): Promise<{ content: string; startLine: number; file: string } | null> {
    const n = this.store.node(id);
    if (!n) return null;
    const text = await this.files.read(n.file);
    if (text === null) return null;
    return {
      content: text.split('\n').slice(n.range.startLine - 1, n.range.endLine).join('\n'),
      startLine: n.range.startLine,
      file: n.file,
    };
  }

  async saveNodeEdit(id: string, newContent: string): Promise<{ ok: boolean; error?: string }> {
    const n = this.store.node(id);
    if (!n) return { ok: false, error: `unknown node ${id}` };
    const decision = this.locks.canEdit(id);
    if (!decision.allowed) return { ok: false, error: decision.reason };
    this.markOwnWrite(n.file);
    const applied = await this.applier.apply([
      { file: n.file, startLine: n.range.startLine, endLine: n.range.endLine, newText: newContent },
    ]);
    if (!applied.ok) return { ok: false, error: applied.error };
    await this.extractFile(n.file);
    this.notifyGraph();
    return { ok: true };
  }

  toggleLock(id: string): boolean {
    const locked = this.store.toggleLock(id, 'manual');
    this.notifyGraph();
    return locked;
  }

  storePath(): string {
    return this.store.filePath;
  }

  // ---- /init scan ------------------------------------------------------------

  async runScan(
    provider: MetaProvider,
    opts: {
      budgetTokens: number;
      onProgress?: (done: number, total: number, id: string, tokens: number) => void;
      shouldStop?: () => boolean;
    }
  ): Promise<ScanResult & { estimatedTotalTokens: number }> {
    const index = this.store.get();
    const estimatedTotalTokens = Math.min(
      estimateTokens(
        (await Promise.all((await this.files.list()).map((f) => this.files.read(f).then((t) => t ?? '')))).join('\n')
      ),
      Number.MAX_SAFE_INTEGER
    );
    const readFile = async (f: string) => (await this.files.read(f)) ?? '';
    const res = await runScan(index, provider, readFile, {
      skipFresh: true,
      budgetTokens: opts.budgetTokens,
      onProgress: opts.onProgress,
      shouldStop: opts.shouldStop,
    });
    // apply proposed default lock tags to new sensitive nodes
    if (res.proposedLockTags.length > 0) {
      const policy = this.store.getLockPolicy();
      this.store.setLockPolicy({
        defaultLockedTags: [...new Set([...policy.defaultLockedTags, ...res.proposedLockTags])],
      });
    }
    this.store.save();
    this.notifyGraph();
    return { ...res, estimatedTotalTokens };
  }

  save(): void {
    this.store.save();
  }
}

interface FileTomb {
  symbols: Map<string, string>;
}

export type { EditApplier, SourceEdit, GraphIndex };
