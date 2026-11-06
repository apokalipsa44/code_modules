import {
  window,
  env,
  ViewColumn,
  Uri,
  type WebviewPanel,
  type Webview,
  type ExtensionContext,
} from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ExtensionRouter } from './router';

/**
 * Graph webview host: CSP-safe, loads the built React app from dist/webview,
 * routes messages through the ExtensionRouter.
 */
export class GraphViewHost {
  private panel: WebviewPanel | null = null;

  constructor(
    private context: ExtensionContext,
    private router: () => ExtensionRouter
  ) {}

  get visible(): boolean {
    return Boolean(this.panel?.visible);
  }

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = window.createWebviewPanel('nodecode.graph', 'NodeCode Graph', ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [Uri.file(this.webviewRoot())],
    });
    panel.webview.html = this.html(panel.webview);
    const router = this.router();
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      try {
        await router.handle(msg as Parameters<ExtensionRouter['handle']>[0]);
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: String(err) });
      }
    });
    panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel = panel;
  }

  post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private webviewRoot(): string {
    return path.join(this.context.extensionPath, 'dist', 'webview');
  }

  private html(webview: Webview): string {
    const root = Uri.file(this.webviewRoot());
    const resolve = (p: string) => webview.asWebviewUri(Uri.joinPath(root, p)).toString();
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const assetsDir = path.join(this.webviewRoot(), 'assets');
    const entryFiles: Array<{ file: string; isCss: boolean }> = [];
    try {
      for (const f of fs.readdirSync(assetsDir)) {
        if (f.startsWith('index-') && f.endsWith('.js')) entryFiles.push({ file: 'assets/' + f, isCss: false });
        if (f.startsWith('index-') && f.endsWith('.css')) entryFiles.push({ file: 'assets/' + f, isCss: true });
      }
    } catch {
      /* dist missing */
    }
    return `<!DOCTYPE html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NodeCode</title>
${entryFiles
  .map(({ file, isCss }) =>
    isCss ? `<link rel="stylesheet" href="${resolve(file)}">` : `<script src="${resolve(file)}" nonce="${nonce}"></script>`
  )
  .join('\n')}
</head>
<body>
<div id="root" style="width:100vw;height:100vh"></div>
</body>
</html>`;
  }
}