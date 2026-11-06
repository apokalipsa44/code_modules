import { Range, Position, WorkspaceEdit, Uri, window, workspace, type TextEditorEdit, type WorkspaceConfiguration } from 'vscode';
import type { EditApplier, SourceEdit } from '@nodecode/core';

/**
 * EditApplier implemented on WorkspaceEdit: full undo/redo and dirty-state support.
 */
export function createEditApplier(rootDir: string | undefined): EditApplier {
  return {
    async apply(edits: SourceEdit[]) {
      const we = new WorkspaceEdit();
      for (const e of edits) {
        const uri = await fileUri(e.file, rootDir);
        if (!uri) return { ok: false, error: `cannot resolve file ${e.file}` };
        if (e.endLine < e.startLine) {
          // insertion: zero-width replace just before the target line
          we.insert(uri, new Position(e.startLine - 1, 0), e.newText + '\n');
        } else {
          const start = new Position(e.startLine - 1, 0);
          const end = new Position(e.endLine, 0);
          if (e.newText === '') {
            we.delete(uri, new Range(start, end));
          } else {
            we.replace(uri, new Range(start, end), e.newText + '\n');
          }
        }
      }
      return (await workspace.applyEdit(we))
        ? { ok: true }
        : { ok: false, error: 'workspace.applyEdit returned false' };
    },
  };
}

export async function fileUri(
  posixRelative: string,
  rootDir: string | undefined
): Promise<Uri | null> {
  const root = workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    return Uri.joinPath(root, ...posixRelative.split('/'));
  }
  if (rootDir) return Uri.file(rootDir + '/' + posixRelative);
  const doc = window.activeTextEditor?.document;
  return doc ? Uri.file(rootDirOrEmpty() + '/' + posixRelative) : null;
}

function rootDirOrEmpty(): string {
  return workspace.rootPath ?? '';
}

export type { WorkspaceConfiguration, TextEditorEdit };
