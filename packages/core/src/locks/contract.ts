import type { CodeNode, Contract } from '../model';

/**
 * Contract generation: for a locked node, what the agent may see.
 * Signature + referenced type declarations + summaries. Never the body.
 */
export function buildContract(
  node: CodeNode,
  fileText: string,
  includeTypes = true
): Contract {
  const types: Contract['types'] = [];
  if (includeTypes) {
    const typeNames = extractTypeNames(node.signature);
    for (const name of typeNames) {
      const decl = findTypeDeclaration(name, fileText);
      if (decl) types.push({ name, declaration: decl });
    }
  }
  const meta = node.meta;
  return {
    nodeId: node.id,
    signature: node.signature,
    description: meta?.userSummary ?? '',
    types,
    invariants: meta?.agentSummary.invariants ?? [],
    sideEffects: meta?.agentSummary.sideEffects ?? [],
  };
}

/** Identifiers that look like type references: TypeNames in the signature. */
function extractTypeNames(signature: string): string[] {
  const names = new Set<string>();
  // match [ : <> extends]\s+X and generic X, where X starts uppercase
  const re = /:\s*([A-Z][A-Za-z0-9_]*)|<([A-Z][A-Za-z0-9_]*)|=>\s*([A-Z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null = re.exec(signature);
  while (m) {
    names.add(m[1] ?? m[2] ?? m[3] ?? '');
    m = re.exec(signature);
  }
  return [...names].filter(Boolean);
}

function findTypeDeclaration(name: string, fileText: string): string | null {
  const re = new RegExp(
    `^(?:export\\s+)?(?:type|interface|class|enum)\\s+${name}\\b[^\\n]*(?:\\n(?:(?:export\\s+)?(?:type|interface|class|enum)\\s+${name}[^\\n]*)?)`,
    'm'
  );
  const simple = re.exec(fileText);
  if (simple?.[0]) return simple[0];
  // leading + first following line (interface bodies)
  const lineRe = new RegExp(`^(?:export\\s+)?(?:type|interface|class|enum)\\s+${name}\\b.*$`, 'm');
  const line = lineRe.exec(fileText);
  if (!line) return null;
  const start = line.index;
  const next = fileText.indexOf('\n', start + 1);
  return next === -1 ? fileText.slice(start) : fileText.slice(start, next);
}
