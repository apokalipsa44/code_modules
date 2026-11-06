import { hashOf } from '../hashing';
import type { AgentSummary, CodeNode, GraphIndex, NodeMeta } from '../model';
import { bottomUpOrder } from '../graph/order';

export interface MetaProvider {
  /** Generate summaries + tags for one node. context has sibling/leaf summaries already generated. */
  summarize(
    node: { id: string; name: string; signature: string; kind: string; file: string; source: string },
    context: Array<{ id: string; summary: string }>
  ): Promise<{ userSummary: string; agentSummary: AgentSummary; tags: string[] }>;
}

export interface ScanOptions {
  /** Skip nodes whose metadata is fresh (metaHash === contentHash). */
  skipFresh: boolean;
  /** Hard cap in estimated tokens. 0 = unlimited. */
  budgetTokens: number;
  /** Progress callback. */
  onProgress?(done: number, total: number, nodeId: string, usedTokens: number): void;
  /** Abort signal-ish */
  shouldStop?(): boolean;
}

export interface ScanResult {
  processed: string[];
  skippedFresh: string[];
  failed: Record<string, string>;
  usedTokens: number;
  budgetExceeded: boolean;
  proposedLockTags: string[];
}

/**
 * /init scanner: bottom-up over the dependency graph, reusing fresh summaries
 * of leaves, skipping unchanged nodes, resumable (idempotent: only stale nodes
 * regenerate). Mutates the given index in place (persist by caller).
 */
export async function runScan(
  index: GraphIndex,
  provider: MetaProvider,
  readFile: (file: string) => Promise<string>,
  options: ScanOptions
): Promise<ScanResult> {
  const order = bottomUpOrder(index);
  const result: ScanResult = {
    processed: [],
    skippedFresh: [],
    failed: {},
    usedTokens: 0,
    budgetExceeded: false,
    proposedLockTags: [],
  };
  const contextShared = new Map<string, string>();
  const tagCounter = new Map<string, number>();

  for (const id of order) {
    if (options.shouldStop?.()) break;
    const node = index.nodes[id];
    if (!node) continue;
    if (options.skipFresh && node.meta && !isStale(node)) {
      result.skippedFresh.push(id);
      for (const t of node.tags) tagCounter.set(t, (tagCounter.get(t) ?? 0) + 1);
      continue;
    }
    const source = (await readFile(node.file))
      .split('\n')
      .slice(node.range.startLine - 1, node.range.endLine)
      .join('\n');
    const context = [...contextShared.entries()].slice(0, 40).map(([nid, summary]) => ({ id: nid, summary }));
    try {
      const { userSummary, agentSummary, tags } = await provider.summarize(
        {
          id,
          name: node.symbolPath,
          signature: node.signature,
          kind: node.kind,
          file: node.file,
          source,
        },
        context
      );
      const usedTokens = Math.ceil(source.length / 4) + Math.ceil((userSummary.length + JSON.stringify(agentSummary).length + tags.join(',').length) / 4);
      result.usedTokens += usedTokens;
      if (options.budgetTokens > 0 && result.usedTokens > options.budgetTokens) {
        result.budgetExceeded = true;
        break;
      }
      const meta: NodeMeta = {
        userSummary,
        agentSummary,
        metaHash: node.contentHash,
        stale: false,
      };
      node.meta = meta;
      node.tags = [...new Set([...node.tags, ...tags])];
      result.processed.push(id);
      contextShared.set(id, userSummary);
      for (const t of tags) tagCounter.set(t, (tagCounter.get(t) ?? 0) + 1);
      options.onProgress?.(result.processed.length, order.length, id, result.usedTokens);
    } catch (err) {
      result.failed[id] = String(err);
    }
  }

  // propose default lock policy from frequent sensitive tags
  const sensitive = ['auth', 'payments', 'secrets', 'crypto', 'session', 'security'];
  result.proposedLockTags = [...tagCounter.entries()]
    .filter(([t, c]) => sensitive.includes(t) && c >= 1)
    .map(([t]) => t);
  return result;
}

export function isStale(node: CodeNode): boolean {
  return Boolean(node.meta && node.meta.metaHash !== node.contentHash);
}

/** Stamp staleness across the index after re-extraction hashes changed. */
export function markStale(index: GraphIndex): string[] {
  const stale: string[] = [];
  for (const node of Object.values(index.nodes)) {
    if (node.meta && node.meta.metaHash !== node.contentHash && !node.meta.stale) {
      node.meta.stale = true;
      stale.push(node.id);
    }
  }
  return stale;
}

/** Deterministic offline meta provider fallback when no model is configured. */
export function heuristicMetaProvider(): MetaProvider {
  return {
    async summarize({ name, signature, kind, file }) {
      const layer = guessTag(file, kind);
      const userSummary = `${kind} ${name} in ${file}.`;
      const inputs = signature.replace(/^[^(]*\(/, '').slice(0, 120) || 'none';
      return {
        userSummary,
        agentSummary: {
          inputs,
          outputs: signature.split('=>').pop()?.trim() ?? 'unknown',
          invariants: [],
          sideEffects: [],
        },
        tags: layer,
      };
    },
  };
}

function guessTag(file: string, kind: string): string[] {
  const tags: string[] = [];
  const f = file.toLowerCase();
  if (/auth|session|login|jwt|token|cookie/.test(f + kind)) tags.push('auth');
  if (/payment|billing|stripe|charge|invoice/.test(f)) tags.push('payments');
  if (/(^|\/)api(\/|$)|route|controller/.test(f)) tags.push('api');
  if (/cookie/.test(f)) tags.push('cookies');
  if (/db|database|repository|model(?!s)/.test(f)) tags.push('db');
  if (/components?|ui|view|screen|pages?/.test(f) || kind === 'component') tags.push('ui');
  if (tags.length === 0) tags.push('core');
  return tags;
}

export function metaHashOf(source: string): string {
  return hashOf(source);
}
