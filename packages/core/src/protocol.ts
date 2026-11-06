/**
 * Typed message protocol between the extension host and the webview.
 * Single source of truth (webview imports types from here; no drift).
 * The webview only renders state and sends intents — no business logic.
 */

import type { CodeNode, CodeEdge } from './model';

/** Node-shaped payload for the canvas. */
export interface GraphNodeDTO {
  id: string;
  label: string;
  kind: string;
  file: string;
  tags: string[];
  locked: boolean;
  lockReason: string;
  summary: string;
  stale: boolean;
  signature: string;
  startLine: number;
  endLine: number;
}

export type FromExtensionToWebview =
  | {
      type: 'graphUpdated';
      nodes: GraphNodeDTO[];
      edges: CodeEdge[];
      layers: string[];
    }
  | { type: 'nodeContent'; id: string; file: string; content: string; startLine: number }
  | { type: 'nodeDiff'; id: string; oldContent: string; newContent: string }
  | { type: 'agentProgress'; message: string; kind: 'info' | 'edit' | 'blocked' | 'error' }
  | { type: 'agentDone'; reply: string }
  | { type: 'lockChanged'; id: string; locked: boolean }
  | { type: 'contentConflict'; id: string; oldContent: string; newContent: string; newFileContent: string }
  | { type: 'error'; message: string };

export type FromWebviewToExtension =
  | { type: 'ready' }
  | { type: 'search'; query: string; depth: number; layerFilter?: string[] }
  | { type: 'expandNode'; id: string; depth: number; layerFilter?: string[] }
  | { type: 'revealNode'; id: string }
  | { type: 'startEdit'; id: string }
  | { type: 'saveEdit'; id: string; content: string }
  | { type: 'cancelEdit'; id: string }
  | { type: 'toggleLock'; id: string }
  | { type: 'refresh'; full?: boolean }
  | { type: 'agentRun'; rootIds: string[]; instruction: string }
  | { type: 'applyDiff'; id: string; accept: boolean }
  | { type: 'initScan'; folder?: string };

export function nodeToDto(
  n: CodeNode,
 GraphNodeDTOHack?: never
): GraphNodeDTO {
  void GraphNodeDTOHack;
  return {
    id: n.id,
    label: n.symbolPath,
    kind: n.kind,
    file: n.file,
    tags: n.tags,
    locked: n.locked,
    lockReason: n.lockReason,
    summary: n.meta?.userSummary ?? '',
    stale: Boolean(n.meta && n.meta.stale && n.meta.metaHash !== n.contentHash),
    signature: n.signature,
    startLine: n.range.startLine,
    endLine: n.range.endLine,
  };
}

export function isFromWebview(msg: unknown): msg is FromWebviewToExtension {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { type?: unknown }).type === 'string' &&
    WEBOVIEW_INTENTS.has((msg as { type: string }).type)
  );
}

const WEBOVIEW_INTENTS = new Set<string>([
  'ready',
  'search',
  'expandNode',
  'revealNode',
  'startEdit',
  'saveEdit',
  'cancelEdit',
  'toggleLock',
  'refresh',
  'agentRun',
  'applyDiff',
  'initScan',
]);
