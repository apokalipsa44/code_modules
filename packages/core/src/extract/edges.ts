import type { CodeEdge } from '../model';
import { resolveImport } from './tsExtractor';
import type { FileExtraction } from './tsExtractor';

export interface EdgeBuilderIo {
  exists(path: string): boolean;
}

/**
 * Fallback edge builder: pure lexical/import analysis, no LSP required.
 * Rules:
 *  - imported symbol used inside a node -> 'imports' edge to the exporting node;
 *  - same-file bare identifier matching a sibling symbol -> 'calls' edge.
 * Confidence is lower than LSP but it keeps the graph alive before the language
 * server warms up.
 */
export function buildFallbackEdges(
  extractions: Map<string, FileExtraction>,
  io: EdgeBuilderIo
): CodeEdge[] {
  const edges: CodeEdge[] = [];
  for (const [file, fx] of extractions) {
    for (const node of fx.nodes) {
      const ids = fx.refs[node.id] ?? [];
      for (const ident of ids) {
        // same-file reference
        const local = [...fx.nodes]
          .filter((n) => n.file === file && n.id !== node.id)
          .find((n) => matchesSymbol(n, ident));
        if (local) {
          edges.push({ from: node.id, to: local.id, type: 'calls' });
        }
        // imported symbol
        const spec = fx.importSymbols[ident];
        if (spec) {
          const targetFile = resolveImport(file, spec, io);
          if (targetFile) {
            const target = extractions.get(targetFile);
            const targetNode = target?.nodes.find((n) => matchesSymbol(n, ident));
            if (targetNode && targetNode.id !== node.id) {
              edges.push({ from: node.id, to: targetNode.id, type: 'imports' });
            }
          }
        }
      }
    }
  }
  return edges;
}

function matchesSymbol(n: FileExtraction['nodes'][number], ident: string): boolean {
  return n.symbolPath.split('.').pop() === ident || n.symbolPath === ident;
}
