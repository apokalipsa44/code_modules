import type { CodeEdge, GraphNodeDTO } from '@code_modules/core';
import {
  FromExtensionToWebview as Out,
  FromWebviewToExtension as In,
} from '@code_modules/core';

/**
 * Pure intent router: maps webview intents to service calls and produces the
 * outgoing messages. No vscode imports — unit-testable with fakes.
 */
export interface RouterDeps {
  getGraph(): { nodes: GraphNodeDTO[]; edges: CodeEdge[]; layers: string[] };
  search(query: string, depth: number, layerFilter?: string[]): { nodes: GraphNodeDTO[]; edges: CodeEdge[]; layers: string[] };
  expand(id: string, depth: number, layerFilter?: string[]): { nodes: GraphNodeDTO[]; edges: CodeEdge[]; layers: string[] };
  readNodeSource(id: string): Promise<{ content: string; startLine: number; file: string } | null>;
  saveNodeEdit(id: string, content: string): Promise<{ ok: boolean; error?: string }>;
  toggleLock(id: string): boolean;
  reveal(id: string): void;
  runAgent(rootIds: string[], instruction: string): Promise<string>;
  initScan(folder?: string): Promise<string>;
}

export type WebviewSender = (msg: Out) => void;

export class ExtensionRouter {
  constructor(
    private deps: RouterDeps,
    private send: WebviewSender,
    private lastDepthRef: { depth: number; layerFilter?: string[] }
  ) {}  private graph(payload: { nodes: GraphNodeDTO[]; edges: CodeEdge[]; layers: string[] }): void {
    this.send({ type: 'graphUpdated', ...payload });
  }

  async handle(intent: In): Promise<void> {
    try {
      switch (intent.type) {
        case 'ready':
          this.graph(this.deps.getGraph());
          return;
        case 'search':
          this.lastDepthRef.depth = intent.depth;
          this.lastDepthRef.layerFilter = intent.layerFilter;
          this.graph(this.deps.search(intent.query, intent.depth, intent.layerFilter));
          return;
        case 'expandNode':
          this.graph(this.deps.expand(intent.id, intent.depth, intent.layerFilter));
          return;
        case 'revealNode':
          this.deps.reveal(intent.id);
          return;
        case 'startEdit': {
          const src = await this.deps.readNodeSource(intent.id);
          if (!src) {
            this.send({ type: 'error', message: `code_modules: cannot read ${intent.id}` });
            return;
          }
          this.send({ type: 'nodeContent', id: intent.id, file: src.file, content: src.content, startLine: src.startLine });
          return;
        }
        case 'saveEdit': {
          const res = await this.deps.saveNodeEdit(intent.id, intent.content);
          if (!res.ok) {
            this.send({ type: 'error', message: `code_modules: ${res.error}` });
          } else {
            this.graph(this.deps.getGraph());
          }
          return;
        }
        case 'cancelEdit':
          this.graph(this.deps.getGraph());
          return;
        case 'toggleLock':
          this.deps.toggleLock(intent.id);
          this.graph(this.deps.getGraph());
          return;
        case 'refresh':
          this.graph(intent.full ? this.deps.getGraph() : this.deps.getGraph());
          return;
        case 'applyDiff':
          // diff review happens in the agent run pipeline; here just ack
          this.send({ type: 'agentProgress', message: `diff ${intent.accept ? 'accepted' : 'rejected'} for ${intent.id}`, kind: 'info' });
          return;
        case 'agentRun': {
          const reply = await this.deps.runAgent(intent.rootIds, intent.instruction);
          this.send({ type: 'agentDone', reply });
          this.graph(this.deps.getGraph());
          return;
        }
        case 'initScan': {
          await this.deps.initScan(intent.folder);
          this.graph(this.deps.getGraph());
          return;
        }
        default:
          this.send({ type: 'error', message: 'code_modules: unknown intent' });
      }
    } catch (err) {
      this.send({ type: 'error', message: `code_modules: ${String(err)}` });
    }
  }

  private lastExpanded(id: string, depth: number, layerFilter?: string[]) {
    return this.deps.expand(id, depth, layerFilter);
  }
}
