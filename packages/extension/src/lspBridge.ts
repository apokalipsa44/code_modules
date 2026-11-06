import {
  commands,
  Location as LocationT,
  Uri,
  window,
  workspace,
  type Location,
} from 'vscode';
import { nodeIdFor as nodeId, type CodeEdge } from '@nodecode/core';
import type { WorkspaceGraphService } from './service';
/**
 * LSP bridge: reference/definition-driven edges, falling back to the core's
 * lexical import analysis which is always available.
 */
export class LspBridge {
  constructor(
    private service: WorkspaceGraphService,
    private relativeUri: (file: string) => Uri | null
  ) {}

  /** Reciprocal edges for the given node ids, `depth` levels deep. */
  async referenceEdges(ids: string[], depth: number): Promise<CodeEdge[]> {
    const edges: CodeEdge[] = [];
    const maxDepth = Math.max(1, Math.min(depth, 3));
    let frontier = ids.slice();
    const seen = new Set(frontier);
    for (let level = 0; level < maxDepth && frontier.length; level++) {
      const next: string[] = [];
      for (const id of frontier) {
        const node = this.service.node(id);
        if (!node) continue;
        const uri = this.relativeUri(node.file);
        if (!uri) continue;
        try {
          const refs = await commands.executeCommand<LocationT[]>(
            'vscode.executeReferenceProvider',
            uri,
            { line: node.range.startLine - 1, character: 0 }
          );
          const fromIds = await this.locationsToNodeIds(refs ?? []);
          for (const from of fromIds) {
            if (from && from !== id) {
              edges.push({ from, to: id, type: 'calls' });
              if (!seen.has(from)) {
                seen.add(from);
                next.push(from);
              }
            }
          }
        } catch {
          // LSP not ready — core fallback edges were already merged
        }
      }
      frontier = next;
    }
    return edges;
  }

  /** Map reference Locations back to node ids (definition position inside range). */
  private async locationsToNodeIds(locations: LocationT[]): Promise<string[]> {
    const out = new Set<string>();
    for (const loc of locations) {
      try {
        const doc = await workspace.openTextDocument(loc.uri);
        const fileRel = this.serviceRelativePath(loc.uri.fsPath);
        if (!fileRel) continue;
        const line = loc.range.start.line + 1;
        for (const node of Object.values(this.service.store.get().nodes)) {
          if (node.file === fileRel && line >= node.range.startLine && line <= node.range.endLine) {
            out.add(node.id);
            break;
          }
        }
        void doc;
      } catch {
        /* uri not openable */
      }
    }
    return [...out];
  }

  private serviceRelativePath(fsPath: string): string | null {
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    const rel = fsPath.startsWith(root) ? fsPath.slice(root.length + 1).replace(/\\/g, '/') : null;
    return rel;
  }

  /** Workspace-symbol based candidate resolution, merged into core score. */
  async workspaceSymbolCandidates(query: string): Promise<string[]> {
    try {
      const symbols = await commands.executeCommand<Array<{ name: string; location: Location }>>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );
      const ids: string[] = [];
      for (const sym of (symbols ?? []).slice(0, 30)) {
        const rel = this.serviceRelativePath(sym.location.uri.fsPath);
        if (!rel) continue;
        const id = nodeId(rel, sym.name);
        if (this.service.node(id)) ids.push(id);
      }
      return ids;
    } catch {
      return [];
    }
  }
}

export async function revealNode(uri: Uri, line: number): Promise<void> {
  const { Range, Selection, Position } = await import('vscode');
  const editor = await window.showTextDocument(uri, { preview: true });
  const pos = new Position(line - 1, 0);
  const range = new Range(pos, pos);
  editor.selection = new Selection(pos, pos);
  editor.revealRange(range);
}
