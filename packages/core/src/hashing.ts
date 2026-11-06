import { createHash } from 'node:crypto';

export function hashOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function digestHex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Rough token estimate for budget caps (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
