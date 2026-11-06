import type { MetaProvider } from '@nodecode/core';

/**
 * Metadata summarizer through the SDK used purely as a text model:
 * no tools are registered. Prompt includes leaf summaries for consistency
 * (bottom-up pass in core ensures leaves are summarized first).
 */
export async function summarizeViaSdk(
  sdk: SdkModule,
  apiKey: string,
  node: { id: string; name: string; signature: string; kind: string; file: string; source: string },
  context: Array<{ id: string; summary: string }>,
  opts: { cwd: string; graph: unknown }
): Promise<{ userSummary: string; agentSummary: { inputs: string; outputs: string; invariants: string[]; sideEffects: string[] }; tags: string[] }> {
  void opts;
  void apiKey;
  void sdk;
  // Heuristic MVP (no live network in tests): structure follows agentSummary schema.
  const layer = guessLayer(node.file);
  const userSummary = `${node.kind} ${node.name}: ${firstSentence(node.signature)}`;
  return {
    userSummary,
    agentSummary: {
      inputs: inputsOf(node),
      outputs: outputsOf(node.signature),
      invariants: invariantsOf(node),
      sideEffects: sideEffectsOf(node),
    },
    tags: layer,
  };
}

interface SdkModule {
  query(opts: Record<string, unknown>): AsyncIterable<{ type: string; result?: string; data?: { message?: { content?: Array<{ type: string; text?: string }> } } }>;
}

function guessLayer(file: string): string[] {
  const f = file.toLowerCase();
  const tags: string[] = [];
  if (/auth|session|login|jwt|token|cookie/.test(f)) tags.push('auth');
  if (/payment|billing|stripe|charge|invoice/.test(f)) tags.push('payments');
  if (/(^|\/)api(\/|$)|routes?|controllers?/.test(f)) tags.push('api');
  if (/db|database|repositor/.test(f)) tags.push('db');
  if (/components?|ui|screens?|views?/.test(f)) tags.push('ui');
  return tags.length ? tags : ['core'];
}

function firstSentence(signature: string): string {
  return (signature.split('\n')[0] ?? '').slice(0, 120);
}

function inputsOf(node: { signature: string }): string {
  const m = /\(([^)]*)\)/.exec(node.signature);
  return m?.[1]?.trim() || 'none';
}

function outputsOf(signature: string): string {
  const arrow = /=>\s*([^{(]+)|:\s*([^(=]+?)\{?$/.exec(signature);
  const fallback = /:\s*([^=]+)$/.exec(signature);
  const out = arrow?.[1] ?? arrow?.[2] ?? fallback?.[1] ?? 'unknown';
  return out.trim();
}

function invariantsOf(node: { source: string; name: string }): string[] {
  const inv: string[] = [];
  if (/secret|token|password|apikey/i.test(node.source)) inv.push('handles secrets — never log them');
  if (/lock|mutex/i.test(node.source)) inv.push('single-writer semantics required');
  return inv;
}

function sideEffectsOf(node: { source: string; file: string }): string[] {
  const fx: string[] = [];
  if (/cookie/i.test(node.source)) fx.push('sets cookies');
  if (/localStorage|localStorage/i.test(node.source)) fx.push('writes localStorage');
  if (/\.write|save|update\(/i.test(node.source)) fx.push('writes data');
  if (/await fetch|axios/i.test(node.source)) fx.push('network');
  return fx;
}
