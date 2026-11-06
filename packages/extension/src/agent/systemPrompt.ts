import type { AgentContext } from '@code_modules/core';

export function agentSystemPrompt(ctx: AgentContext): string {
  const lines: string[] = [
    'You are the code_modules agent working on a TypeScript/JavaScript codebase.',
    'Rules:',
    '- You have NO filesystem or shell access. Your only tools are the code_modules node tools.',
    '- Locked nodes are immutable: edit_node is physically rejected for them (you will see LOCKED errors).',
    '- To change behavior of a locked node, propose the change to the USER instead of editing.',
    '- After edits, run_checks is run automatically; keep the public surface of locked dependents intact.',
  ];
  if (ctx.contracts.length) {
    lines.push('', 'LOCKED NODES (contracts only — implementation is not exposed):');
    for (const c of ctx.contracts) {
      lines.push(`- ${c.nodeId}: ${c.signature}`);
      if (c.description) lines.push(`  description: ${c.description}`);
      if (c.invariants.length) lines.push(`  invariants: ${c.invariants.join('; ')}`);
      if (c.staleWarning) lines.push(`  ⚠ ${c.staleWarning}`);
    }
  }
  lines.push('', 'EDITABLE NODES (you may read and edit these):');
  for (const n of ctx.full) lines.push(`- ${n.id} (${n.kind}, tags: ${n.tags.join(',') || 'none'})`);
  for (const w of ctx.warnings) lines.push('', `⚠ ${w}`);
  return lines.join('\n');
}
