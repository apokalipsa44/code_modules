import type { CodeEdge, CodeNode, GraphIndex } from '../model';

/**
 * Bottom-up processing order for /init: pure leaves (no outgoing "depends on"
 * edges) first, then nodes whose dependencies are all processed. Cycles are
 * broken by remaining out-degree (fewest dependencies first).
 */
export function bottomUpOrder(index: GraphIndex): string[] {
  const nodes = Object.keys(index.nodes);
  const outgoing = new Map<string, Set<string>>();
  for (const id of nodes) outgoing.set(id, new Set());
  for (const e of index.edges) {
    if (outgoing.has(e.from) && outgoing.has(e.to)) {
      outgoing.get(e.from)!.add(e.to);
    }
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < nodes.length) {
    // candidates: not done, all deps done
    const candidates = nodes.filter(
      (id) =>
        !done.has(id) &&
        [...outgoing.get(id)!].every((dep) => !outgoing.has(dep) || done.has(dep))
    );
    const pool = candidates.length
      ? candidates
      : nodes
          .filter((id) => !done.has(id))
          .sort((a, b) => outgoing.get(a)!.size - outgoing.get(b)!.size);
    // take all zero-dependency candidates this round (keeps flat graphs cheap)
    if (candidates.length) {
      for (const c of candidates) {
        done.add(c);
        order.push(c);
      }
    } else {
      const c = pool[0]!;
      done.add(c);
      order.push(c);
    }
  }
  return order;
}

/** BFS closure over transitive dependents/deps (bounded by 8 levels). */
export function transitive(
  index: GraphIndex,
  roots: string[],
  direction: 'deps' | 'dependents'
): Set<string> {
  const seen = new Set(roots);
  let frontier = [...seen];
  for (let level = 0; level < 8 && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of neighbors(index, id, direction)) {
        if (!seen.has(n)) next.push(n);
      }
    }
    for (const n of next) seen.add(n);
    frontier = next;
  }
  for (const r of roots) seen.delete(r);
  return seen;
}

/** Direct neighbours by edge type. */
export function neighbors(
  index: GraphIndex,
  id: string,
  direction: 'deps' | 'dependents'
): string[] {
  const set = new Set<string>();
  for (const e of index.edges) {
    if (direction === 'deps' && e.from === id) set.add(e.to);
    if (direction === 'dependents' && e.to === id) set.add(e.from);
  }
  return [...set];
}

/** BFS closure over edges up to `depth` levels from the roots. */
export function expandSubgraph(
  index: GraphIndex,
  roots: string[],
  depth: number,
  layerFilter?: string[]
): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const maxDepth = Math.max(0, Math.min(depth, 8));
  const include = new Set<string>(roots.filter((r) => index.nodes[r]));
  let frontier = [...include];
  for (let level = 0; level < maxDepth; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of neighbors(index, id, 'deps')) {
        if (!include.has(dep)) next.push(dep);
      }
    }
    for (const id of next) include.add(id);
    frontier = next;
  }
  let nodes = Object.values(index.nodes).filter((n) => include.has(n.id));
  if (layerFilter && layerFilter.length) {
    // keep nodes matching a shown layer, plus roots always
    const rootIds = new Set(roots);
    nodes = nodes.filter(
      (n) => rootIds.has(n.id) || n.tags.some((t) => layerFilter.includes(t))
    );
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = index.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  return { nodes, edges };
}

export function allLayers(index: GraphIndex): string[] {
  const layers = new Set<string>();
  for (const n of Object.values(index.nodes)) for (const t of n.tags) layers.add(t);
  return [...layers].sort();
}
