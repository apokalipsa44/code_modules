import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  emptyIndex,
  SCHEMA_VERSION,
  type CodeEdge,
  type CodeNode,
  type GraphIndex,
  type LockPolicy,
} from '../model';
import type { FileExtraction } from '../extract/tsExtractor';
import { LockEngine, applyDefaultLocks } from '../locks/engine';

/**
 * Persists the graph index to .nodes/index.json (versioned, team-shareable).
 * Merging is id-preserved: user state (locked/tags/meta) survives re-extraction;
 * renames/moves are re-linked by content hash.
 */
export class GraphStore {
  private index: GraphIndex = emptyIndex();
  private readonly lockEngine: LockEngine;

  constructor(
    /** Absolute or relative path of .nodes/index.json. */
    public filePath: string
  ) {
    this.lockEngine = new LockEngine();
  }

  /** Persisted user state for a node id. */
  private static trackedState(n: CodeNode): Partial<CodeNode> | null {
    if (n.locked || n.lockReason || n.tags.length > 0 || n.meta) {
      return { locked: n.locked, lockReason: n.lockReason, tags: n.tags, meta: n.meta };
    }
    return null;
  }

  load(): GraphIndex {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.index = migrate(JSON.parse(raw) as Partial<GraphIndex>);
    } catch {
      this.index = emptyIndex();
    }
    this.lockEngine.attach(this.index);
    return this.index;
  }

  get(): GraphIndex {
    return this.index;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    this.index.generatedAt = new Date().toISOString();
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  setIndex(index: GraphIndex): void {
    this.index = migrate(index);
    this.lockEngine.attach(this.index);
  }

  setLockPolicy(lockPolicy: LockPolicy): void {
    this.index.lockPolicy = lockPolicy;
  }

  getLockPolicy(): LockPolicy {
    return this.index.lockPolicy;
  }

  /** Replace the extracted nodes of one file; run incremental re-extraction on save. */
  mergeFileExtraction(file: string, extraction: FileExtraction): MergeResult {
    const result: MergeResult = { added: [], removed: [], relinked: [], nodes: [] };
    const previous = new Map(
      Object.values(this.index.nodes)
        .filter((n) => n.file === file)
        .map((n) => [n.id, n] as const)
    );
    const freshIds = new Set(extraction.nodes.map((n) => n.id));
    const idState = new Map<string, Partial<CodeNode>>();
    for (const [id, prev] of previous) {
      const state = GraphStore.trackedState(prev);
      if (state) {
        idState.set(id, state);
        if (!freshIds.has(id)) {
          // node disappeared: keep its state keyed by content hash so a later
          // rename/move of the same code can reclaim the lock/meta/tags
          this.tombstones.set(prev.contentHash, state);
          result.removed.push(id);
        }
      }
    }

    for (const id of previous.keys()) {
      delete this.index.nodes[id];
    }
    this.index.edges = this.index.edges.filter(
      (e) => !e.from.startsWith(file + '#') && !e.to.startsWith(file + '#')
    );

    for (const fresh of extraction.nodes) {
      const node: CodeNode = {
        ...fresh,
        locked: false,
        lockReason: '',
        tags: fresh.tags.slice(),
      };
      const kept = idState.has(fresh.id);
      if (kept) {
        Object.assign(node, idState.get(fresh.id) ?? {});
        result.nodes.push(node.id);
      } else {
        const tomb = this.tombstones.get(fresh.contentHash);
        if (tomb) {
          Object.assign(node, tomb);
          this.tombstones.delete(fresh.contentHash);
          result.relinked.push(node.id);
        } else if (this.index.nodes[fresh.id] === undefined) {
          applyDefaultLocks(node, this.index.lockPolicy);
          result.added.push(node.id);
        }
      }
      this.index.nodes[node.id] = node;
    }

    this.lockEngine.attach(this.index);
    return result;
  }

  private tombstones = new Map<string, Partial<CodeNode>>();

  upsertEdges(edges: CodeEdge[]): void {
    for (const e of edges) {
      const key = (x: CodeEdge) => `${x.from}|${x.to}|${x.type}`;
      const exists = this.index.edges.some((x) => key(x) === key(e));
      if (!exists) this.index.edges.push(e);
    }
  }

  replaceEdges(edges: CodeEdge[]): void {
    this.index.edges = dedupeEdges(edges);
  }

  node(id: string): CodeNode | undefined {
    return this.index.nodes[id];
  }

  allNodes(): CodeNode[] {
    return Object.values(this.index.nodes);
  }

  files(): string[] {
    return [...new Set(this.allNodes().map((n) => n.file))];
  }

  toggleLock(id: string, reason?: string): boolean {
    const n = this.index.nodes[id];
    if (!n) throw new Error(`code_modules: unknown node ${id}`);
    n.locked = !n.locked;
    n.lockReason = n.locked ? (reason ?? 'manual') : '';
    return n.locked;
  }

  setLocked(id: string, locked: boolean, reason = 'manual'): void {
    const n = this.index.nodes[id];
    if (!n) throw new Error(`code_modules: unknown node ${id}`);
    n.locked = locked;
    n.lockReason = locked ? reason : '';
  }
}

export interface MergeResult {
  added: string[];
  removed: string[];
  relinked: string[];
  nodes: string[];
}

export function dedupeEdges(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  const out: CodeEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** Forward-compatible migration table; v1 is the current shape. */
export function migrate(raw: Partial<GraphIndex>): GraphIndex {
  if (!raw || typeof raw !== 'object') return emptyIndex();
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  const index: GraphIndex = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: raw.generatedAt,
    nodes: raw.nodes ?? {},
    edges: reallocEdges(raw.edges ?? []),
    lockPolicy: raw.lockPolicy ?? { defaultLockedTags: ['auth', 'payments'] },
  };
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `code_modules: index schema v${version} is newer than supported v${SCHEMA_VERSION}`
    );
  }
  if (version < SCHEMA_VERSION) {
    // v0 => v1: nodes were arrays, coerce defensively
    const nodes: Record<string, CodeNode> = {};
    const list = (raw as unknown as { nodes?: unknown }).nodes;
    if (Array.isArray(list)) {
      for (const n of list as CodeNode[]) {
        if (n?.id) nodes[n.id] = n;
      }
      index.nodes = nodes;
    }
  }
  return index;
}

function reallocEdges(edges: CodeEdge[]): CodeEdge[] {
  return edges.filter((e) => e && e.from && e.to);
}

export const defaultIndexPath = (workspaceRoot: string): string =>
  path.join(workspaceRoot, '.nodes', 'index.json');
