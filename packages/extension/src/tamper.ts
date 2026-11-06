import { TabInputText, TextDocumentSaveReason, TextDocumentWillSaveEvent, window, workspace, commands, type Uri } from 'vscode';
import type { WorkspaceGraphService } from './service';

/**
 * Defense in depth for locks OUTSIDE the agent:
 *  - onWillSaveTextDocument: if a locked range changes with no prior unlock
 *    through NodeCode (git pull, manual edit, another tool), warn before saving.
 *  - offer review / accept; reject = save as usual but with a visible flag.
 */
export function registerTamperGuard(service: WorkspaceGraphService, getRootFile: (uri: string) => string | null): { dispose: () => void } {
  let suppressing = false;

  const handler = async (event: TextDocumentWillSaveEvent) => {
    if (suppressing) return;
    const doc = event.document;
    if (doc.uri.scheme !== 'file') return;
    const file = getRootFile(doc.fileName);
    if (!file) return;
    service.markOwnWrite(file); // VS Code willSave fires after our own saves too
    const locked = Object.values(service.store.get().nodes).filter(
      (n) => n.locked && n.file === file
    );
    if (locked.length === 0) return;
    const changed: string[] = [];
    for (const n of locked) {
      const lines = doc.getText().split('\n');
      const current = lines.slice(n.range.startLine - 1, n.range.endLine).join('\n');
      const previous = service.lastSeen.get(file)?.split('\n')?.slice(n.range.startLine - 1, n.range.endLine)?.join('\n') ?? '';
      if (current !== previous) {
        changed.push(n.id);
      }
    }
    if (changed.length === 0) return;
    const pick = await window.showWarningMessage(
      `NodeCode: locked node(s) changed outside NodeCode: ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? '…' : ''} — review?`,
      { modal: false },
      'Review diff',
      'Accept changes'
    );
    if (pick === 'Review diff') {
      // open the ORIGINAL content side-by-side from git-less baseline stored text
      await commands.executeCommand('vscode.diff', doc.uri, doc.uri, 'NodeCode: review external change to locked node');
    } else if (pick === 'Accept changes') {
      for (const id of changed) {
        const n = service.store.node(id);
        if (!n) continue;
        service.refreshTamperBaseline(file, doc.getText());
        // metadata is now definitively stale
        if (n.meta) n.meta.stale = true;
      }
      service.save();
    }
  };

  return workspace.onWillSaveTextDocument(handler as (e: TextDocumentWillSaveEvent) => unknown);
}

export function lastSeenPreview(text: string | undefined, range: { startLine: number; endLine: number }): string {
  if (!text) return '';
  return text.split('\n').slice(range.startLine - 1, range.endLine).join('\n');
}

export type { TabInputText, TextDocumentSaveReason, Uri };
