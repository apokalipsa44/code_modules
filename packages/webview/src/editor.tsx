import React, { useEffect, useRef } from 'react';

interface Props {
  initial: string;
  language: string;
  onSave(code: string): void;
}

/**
 * Monaco editor embedded in a node card. Workers are bundled by Vite,
 * loaded on first use (keeps initial graph render light).
 */
interface EditorLike {
  getValue(): string;
  addCommand(keybinding: unknown, callback: () => void): void;
  dispose(): void;
}

export const MonacoNodeEditor: React.FC<Props> = ({ initial, language, onSave }) => {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let editor: EditorLike | null = null;
    (async () => {
      const monaco = await import('monaco-editor');
      const editorWorkerCtor = (await import('monaco-editor/esm/vs/editor/editor.worker?worker')).default;
      const tsWorkerCtor = (await import('monaco-editor/esm/vs/language/typescript/ts.worker?worker')).default;
      (globalThis as unknown as { MonacoEnvironment: { getWorker(id: string, label: string): Worker } }).MonacoEnvironment = {
        getWorker(_id: string, label: string) {
          return label === 'typescript' || label === 'javascript' || label === 'tsx' ? new tsWorkerCtor() : new editorWorkerCtor();
        },
      };
      if (disposed || !ref.current) return;
      editor = monaco.editor.create(ref.current, {
        value: initial,
        language: language === 'tsx' ? 'typescript' : language,
        minimap: { enabled: false },
        automaticLayout: true,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        fontSize: 12,
      });
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          onSave(editor!.getValue());
        }
      );
    })();
    return () => {
      disposed = true;
      editor?.dispose();
    };
  }, [initial]);

  return (
    <div className="nodecard-editor">
      <div ref={ref} style={{ width: 236, height: 170, textAlign: 'left' }} />
      <div className="editor-hints">⌘/Ctrl+S saves via WorkspaceEdit (undoable)</div>
    </div>
  );
};
