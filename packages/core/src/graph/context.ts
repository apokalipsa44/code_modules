import type { GraphIndex } from '../model';
import { buildContract } from '../locks/contract';
import { expandSubgraph } from './order';
import type { CodeNode, ContractView } from '../model';

/**
 * Agent subgraph context: editable nodes in full, locked nodes as contracts,
 * with stale-metadata warnings that the agent must see.
 */
export interface AgentContext {
  /** Editable nodes: full source bodies (agent may read/edit these). */
  full: CodeNode[];
  /** Locked nodes: contract views only (signature, types, invariants). */
  contracts: ContractView[];
  /** System-level warnings to inject into the agent prompt. */
  warnings: string[];
  edges: GraphIndex['edges'];
}

export interface SubgraphOptions {
  depth: number;
  layerFilter?: string[] | null;
  lockPolicyMatching?: null;
}

export function buildSubgraphContext(
  index: GraphIndex,
  roots: string[],
  options: SubgraphOptions,
  isLocked: (node: CodeNode) => boolean
): AgentContext {
  const { nodes, edges } = expandSubgraph(index, roots, options.depth, options.layerFilter ?? undefined);
  const full: CodeNode[] = [];
  const contracts: ContractView[] = [];
  const warnings: string[] = [];

  for (const node of nodes) {
    if (isLocked(node)) {
      const contract: ContractView = {
        ...buildContract(node, ''),
        staleWarning: undefined,
      };
      if (node.meta && node.meta.metaHash !== node.contentHash) {
        contract.staleWarning = `metadata for ${node.id} is STALE (code changed since generation)`;
        warnings.push(`metadata for ${node.id} is stale — do not rely on it`);
      }
      contracts.push(contract);
    } else {
      full.push(node);
    }
  }
  return { full, contracts, warnings, edges };
}
