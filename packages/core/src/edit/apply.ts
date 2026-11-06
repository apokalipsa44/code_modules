/**
 * Source edits are line-ranged replacements. The extension implements
 * EditApplier with WorkspaceEdit so undo/redo and dirty state work natively.
 * Core fakes use in-memory buffers.
 */

export interface SourceEdit {
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  newText: string;
}

export type EditResult =
  | { ok: true }
  | { ok: false; error: string };

export interface EditApplier {
  apply(edits: SourceEdit[]): Promise<EditResult>;
}

/** Apply edits into a text buffer model (array of lines) — pure, used by tests and to simulate. */
export function applyEditsToText(text: string, edits: SourceEdit[]): string {
  const lines = text.split('\n');
  const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);
  for (const e of sorted) {
    const startIdx = Math.max(0, e.startLine - 1);
    const endIdx = Math.min(lines.length, e.endLine);
    const replacement = e.newText === '' ? [] : e.newText.split('\n');
    lines.splice(startIdx, endIdx - startIdx, ...replacement);
  }
  return lines.join('\n');
}
