import type { AgentToolContext } from '@code_modules/core';

/**
 * Review mode: agent edits don't auto-apply; they go to the webview as diffs
 * and are applied/rejected via the 'applyDiff' intent. Auto-apply (default)
 * bypasses this entirely.
 */
export class PendingEdits {
  private pending = new Map<
    number,
    { edit: UnknownEdit; resolve: (accept: boolean) => void; description: string }
  >();
  private nextId = 1;

  propose(edit: UnknownEdit, description: string, notify: (payload: { id: number; description: string; edit: UnknownEdit }) => void): Promise<boolean> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { edit, resolve, description });
      notify({ id, description, edit });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve(false); // timeout => rejected
        }
      }, 300000);
    });
  }

  resolve(id: number, accept: boolean): { found: boolean; edit?: UnknownEdit } {
    const entry = this.pending.get(id);
    if (!entry) return { found: false };
    this.pending.delete(id);
    entry.resolve(accept);
    return { found: true, edit: entry.edit };
  }

  get size(): number {
    return this.pending.size;
  }
}

export type UnknownEdit = { file: string; startLine: number; endLine: number; newText: string };

/** Wrap an AgentToolContext so edits flow through PendingEdits when review is on. */
export function reviewingToolContext(
  ctx: AgentToolContext,
  pending: PendingEdits,
  notify: (payload: { id: number; description: string; edit: UnknownEdit }) => void
): AgentToolContext {
  return {
    ...ctx,
    applier: {
      async apply(edits) {
        let lastOk = true;
        let lastError: string | undefined;
        for (const edit of edits) {
          const accepted = await pending.propose(edit, `edit ${edit.file}:${edit.startLine}-${edit.endLine}`, notify);
          if (!accepted) {
            return { ok: false, error: 'review rejected edit' };
          }
          const res = await ctx.applier.apply([edit]);
          if (!res.ok) {
            lastOk = false;
            lastError = res.error;
          }
        }
        return lastOk ? { ok: true } : { ok: false, error: lastError ?? 'edit failed' };
      },
    },
  };
}
