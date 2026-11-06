/**
 * NodeCode core data model. Versioned, migration-ready.
 * All persisted shapes live here so `.nodes/index.json` has a single source of truth.
 */

export const SCHEMA_VERSION = 1;

export type NodeKind =
  | 'function'
  | 'class'
  | 'method'
  | 'component'
  | 'route'
  | 'const'
  | 'config'
  | 'type';

export type EdgeType = 'calls' | 'imports' | 'uses' | 'route';

/** 1-based, inclusive line range. */
export interface SourceRange {
  startLine: number;
  endLine: number;
}

export interface AgentSummary {
  inputs: string;
  outputs: string;
  invariants: string[];
  sideEffects: string[];
}

export interface NodeMeta {
  /** One short sentence for humans. */
  userSummary: string;
  /** Richer structured record for the agent. */
  agentSummary: AgentSummary;
  /** Content hash the metadata was generated from. Differs from `contentHash` => stale. */
  metaHash: string;
  stale: boolean;
}

/**
 * A semantic unit of code. `id` is stable across edits:
 * `<workspace-relative posix file>#<symbol path>`, e.g. `src/auth/session.ts#validateSession`
 * or `src/routes/api.ts#routes.login`.
 */
export interface CodeNode {
  id: string;
  /** Workspace-relative posix path. */
  file: string;
  symbolPath: string;
  name: string;
  kind: NodeKind;
  range: SourceRange;
  /** First line of the declaration, body elided. */
  signature: string;
  /** sha256:<hex> of the node's exact source text. */
  contentHash: string;
  tags: string[];
  locked: boolean;
  lockReason: string;
  meta?: NodeMeta;
}

export interface CodeEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface LockPolicy {
  /** New nodes matching these tags are locked automatically. */
  defaultLockedTags: string[];
}

export interface GraphIndex {
  schemaVersion: number;
  generatedAt?: string;
  nodes: Record<string, CodeNode>;
  edges: CodeEdge[];
  lockPolicy: LockPolicy;
}

export function emptyIndex(): GraphIndex {
  return {
    schemaVersion: SCHEMA_VERSION,
    nodes: {},
    edges: [],
    lockPolicy: { defaultLockedTags: ['auth', 'payments'] },
  };
}

export interface Contract {
  nodeId: string;
  signature: string;
  description: string;
  types: Array<{ name: string; declaration: string }>;
  invariants: string[];
  sideEffects: string[];
}

/** A node with its contract, plus staleness warning (never let the agent rely on stale metadata silently). */
export interface ContractView extends Contract {
  staleWarning?: string;
}
