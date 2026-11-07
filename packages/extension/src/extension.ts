import {
  commands,
  window,
  workspace,
  Uri,
  chat,
  ProgressLocation,
  Range,
  Position,
  Selection,
  type ExtensionContext,
} from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  buildSubgraphContext,
  estimateTokens,
  searchNodes,
  markStale,
  TsExtractor,
  ToolGate,
  type AgentToolContext,
  type EditApplier,
  type MetaProvider,
} from '@code_modules/core';
import { WorkspaceGraphService } from './service';
import { registerTamperGuard } from './tamper';
import { createCheckRunner } from './checks';
import { createEditApplier } from './editApplier';
import { ExtensionRouter, type RouterDeps } from './router';
import { GraphViewHost } from './graphView';
import { LspBridge } from './lspBridge';
import { getApiKey, promptApiKey } from './secrets';
import { PendingEdits, reviewingToolContext } from './agent/pendingEdits';
import { tryLoadSdk, sdkAgentRun } from './agent/claudeProvider';
import { agentSystemPrompt } from './agent/systemPrompt';
import { summarizeViaSdk } from './agent/scanModel';
import {
  AgentRunner,
  OpenAiCompatProvider,
  lmStudioMetaProvider,
  type OpenAiCompatConfig,
} from '@code_modules/core';

const settings = () => workspace.getConfiguration('code_modules');

/** LM Studio config from settings (btfa parity: base URL must end in /v1, key is a placeholder). */
function lmStudioConfig(): Omit<OpenAiCompatConfig, 'systemPrompt'> {
  const s = settings();
  return {
    baseUrl: s.get<string>('lmStudioBaseUrl') ?? 'http://localhost:1234/v1',
    model: s.get<string>('lmStudioModel') ?? '',
    timeoutMs: s.get<number>('lmStudioTimeoutMs') ?? 120_000,
  };
}

export function activate(context: ExtensionContext): { service: WorkspaceGraphService } {
  const wsFolder = workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    void window.showErrorMessage('code_modules: open a folder first.');
    throw new Error('code_modules: no workspace folder');
  }
  const rootPath = wsFolder.uri.fsPath;
  const relOf = (fsPath: string): string | null =>
    fsPath.startsWith(rootPath) ? path.relative(rootPath, fsPath).replace(/\\/g, '/') : null;
  const fileUri = (rel: string): Uri => Uri.joinPath(wsFolder.uri, ...rel.split('/'));

  const readFile = async (rel: string): Promise<string | null> => {
    try {
      return fs.readFileSync(path.join(rootPath, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const exists = (rel: string): boolean => fs.existsSync(path.join(rootPath, rel));
  const listFiles = async (): Promise<string[]> => {
    const excludes = settings().get<string[]>('excludedFolders') ?? [];
    const files = await workspace.findFiles('**/*.{ts,tsx,js,jsx}', `{${excludes.join(',')}}`, 20000);
    return files.map((f) => relOf(f.fsPath)).filter((f): f is string => Boolean(f));
  };

  const applier: EditApplier = createEditApplier(rootPath);
  const service = new WorkspaceGraphService(
    path.join(rootPath, '.nodes', 'index.json'),
    { list: listFiles, read: readFile, exists },
    applier
  );
  const lsp = new LspBridge(service, (rel) => {
    try {
      return fileUri(rel);
    } catch {
      return null;
    }
  });

  const pendingEdits = new PendingEdits();

  // ---- agent flow -----------------------------------------------------------

  function toolGateCtx(): AgentToolContext {
    const checkRunner = createCheckRunner(settings().get('checkCommand') ?? '', rootPath);
    const base: AgentToolContext = {
      index: service.store.get(),
      locks: service.locks,
      readFile: async (f) => (await readFile(f)) ?? '',
      applier,
      runChecks: checkRunner ? () => checkRunner.run() : undefined,
      refreshAfterEdit: async (f) => {
        await service.extractFile(f);
      },
    };
    if (settings().get<boolean>('reviewEdits')) {
      return reviewingToolContext(base, pendingEdits, (payload) =>
        view.post({
          type: 'nodeDiff',
          id: `pending:${payload.id}`,
          oldContent: '',
          newContent: JSON.stringify(payload.edit, null, 2),
        })
      );
    }
    return base;
  }

  const gate = new ToolGate(toolGateCtx());
  // keep the gate's context synced with settings toggles
  const syncGate = () => Object.assign(gate, { ctx: undefined }) as unknown as void;
  void syncGate;

  async function runAgentFlow(rootIds: string[], instruction: string): Promise<string> {
    view.post({ type: 'agentProgress', message: 'building subgraph context…', kind: 'info' });
    const index = service.store.get();
    const roots = rootIds.length ? rootIds : searchNodes(index, firstQuery(instruction), 3).map((h) => h.node.id);
    const agentCtx = buildSubgraphContext(index, roots, { depth: settings().get<number>('depth') ?? 2, layerFilter: null }, (n) =>
      service.locks.effectivelyLocked(n)
    );
    const systemPrompt = agentSystemPrompt(agentCtx);
    const apiKey = await getApiKey();
    const provider = settings().get<string>('modelProvider') ?? 'claude';

    if (provider === 'lmstudio') {
      try {
        const cfg = lmStudioConfig();
        // Fresh gate: locks + index as of NOW (never reuse a stored index snapshot).
        const liveGate = new ToolGate(toolGateCtx());
        const run = await new AgentRunner(new OpenAiCompatProvider({ ...cfg, systemPrompt }), liveGate).run({
          instruction,
          maxTurns: 12,
        });
        if (run.blocked.length) {
          void window.showWarningMessage(`code_modules: agent tried disallowed tool(s) ${run.blocked.length}× — denied.`);
        }
        await service.ensureScanned(() => undefined);
        const note = run.blocked.length ? `\n(${run.blocked.length} locked/disallowed attempt(s) blocked)` : '';
        return (run.reply || 'done') + note;
      } catch (err) {
        void window.showWarningMessage(
          `code_modules: LM Studio unreachable (${String(err).slice(0, 120)}) — start it at ${settings().get<string>('lmStudioBaseUrl') ?? 'http://localhost:1234'} and load a model.`
        );
        // fall through to the offline mock message below
      }
    }
    if (provider === 'claude' && apiKey) {
      const sdk = await tryLoadSdk();
      if (sdk) {
        try {
          const res = await sdkAgentRun(sdk, apiKey, instruction, toolGateCtx(), gate, {
            systemPrompt,
            model: 'claude-sonnet-4-5',
            cwd: rootPath,
          });
          for (const b of res.blocked) {
            void window.showWarningMessage(`code_modules: agent tried a disallowed tool (${b}); denied.`);
          }
          await service.ensureScanned(() => undefined);
          return res.reply;
        } catch (err) {
          void window.showWarningMessage(`code_modules: SDK run failed (${String(err).slice(0, 140)}) — offline mock used.`);
        }
      }
    }
    if (provider === 'claude' && !apiKey) {
      void promptApiKey();
    }
    return [
      '[offline mock] Agent tools unavailable without an API key.',
      'To enable real runs: store the key (SecretStorage: code_modules.apiKey, see command prompt) and keep code_modules.modelProvider=claude.',
      `Locks still enforced: ${Object.values(index.nodes).filter((n) => n.locked).length} locked node(s) are untouchable in any provider.`,
    ].join('\n');
  }

  function firstQuery(instruction: string): string {
    const q = instruction.split(/[.?!]/)[0] ?? instruction;
    return q.split(/\s+/).slice(0, 4).join(' ');
  }

  // ---- /init ----------------------------------------------------------------

  class SdkMetaProvider implements MetaProvider {
    constructor(private apiKey: string) {}
    async summarize(
      node: { id: string; name: string; signature: string; kind: string; file: string; source: string },
      context: Array<{ id: string; summary: string }>
    ) {
      const sdk = await tryLoadSdk();
      if (!sdk) {
        const { heuristicMetaProvider } = await import('@code_modules/core');
        return heuristicMetaProvider().summarize(node, context);
      }
      return summarizeViaSdk(sdk, this.apiKey, node, context, { cwd: rootPath, graph: service.store.get() });
    }
  }

  async function runInitScan(): Promise<string> {
    await service.ensureScanned();
    const apiKey = await getApiKey();
    const budget = estimateBudget();
    let provider: MetaProvider;
    if (settings().get<string>('modelProvider') === 'lmstudio') {
      provider = lmStudioMetaProvider(lmStudioConfig());
    } else if (apiKey) {
      provider = new SdkMetaProvider(apiKey);
    } else {
      provider = ({
        async summarize(node) {
          const { heuristicMetaProvider } = await import('@code_modules/core');
          return heuristicMetaProvider().summarize(node, []);
        },
      } as MetaProvider);
    }
    await window.withProgress(
      { location: ProgressLocation.Notification, cancellable: true, title: 'code_modules /init' },
      async (progress, token) => {
        const res = await service.runScan(provider, {
          budgetTokens: budget,
          onProgress: (done, total, id, tokens) =>
            progress.report({ message: `${done}/${total} nodes (~${tokens} tokens): ${id}`, increment: 100 / Math.max(total, 1) }),
          shouldStop: () => token.isCancellationRequested,
        });
        void window.showInformationMessage(
          `code_modules /init: ${res.processed.length} generated, ${res.skippedFresh.length} already fresh, ${res.failed.length ? Object.keys(res.failed).length + ' failed' : 'no failures'}; lock tags: ${res.proposedLockTags.join(', ') || 'none'}`
        );
      }
    );
    return 'scan done';
  }

  function estimateBudget(): number {
    const configured = settings().get<number>('initBudgetTokens');
    return typeof configured === 'number' && configured > 0 ? configured : 750000;
  }

  // ---- router ----------------------------------------------------------------

  const deps: RouterDeps = {
    getGraph: () => service.getGraph(),
    search: (query, d, filter) => service.search(query, d, filter),
    expand: (id, d, filter) => service.expand(id, d, filter),
    readNodeSource: (id) => service.readNodeSource(id),
    saveNodeEdit: async (id, content) => service.saveNodeEdit(id, content),
    toggleLock: (id) => service.toggleLock(id),
    reveal: async (id) => {
      const node = service.node(id);
      if (!node) return;
      try {
        const uri = fileUri(node.file);
        const doc = await workspace.openTextDocument(uri);
        const ed = await window.showTextDocument(doc, { preview: true });
        const pos = new Position(node.range.startLine - 1, 0);
        const range = new Range(pos, pos);
        ed.selection = new Selection(pos, pos);        ed.revealRange(range);
      } catch {
        void window.showWarningMessage(`code_modules: cannot reveal ${id}`);
      }
    },
    runAgent: runAgentFlow,
    initScan: runInitScan,
  };

  const view = new GraphViewHost(context, () => router);
  const router = new ExtensionRouter(
    deps,
    (m) => view.post(m),
    { depth: settings().get<number>('depth') ?? 2 }
  );

  // ---- watchers ----------------------------------------------------------------

  let scanning = false;
  context.subscriptions.push(
    workspace.onDidSaveTextDocument(async (doc) => {
      if (scanning) return;
      if (!['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(doc.languageId)) return;
      const rel = relOf(doc.uri.fsPath);
      if (!rel) return;
      await service.extractFile(rel);
      const ids = Object.values(service.store.get().nodes)
        .filter((n) => n.file === rel)
        .map((n) => n.id);
      try {
        const edges = await lsp.referenceEdges(ids, 1);
        service.store.upsertEdges(edges);
      } catch {
        /* LSP not ready; lexical fallback edges remain */
      }
      markStale(service.store.get());
      service.save();
      service.notifyGraph();
    }),
    registerTamperGuard(service, relOf)
  );

  try {
    const renameDisposable = workspace.onDidRenameFiles(async (e) => {
      scanning = true;
      try {
        for (const f of e.files) {
          const fromRel = relOf(f.oldUri.fsPath);
          const toRel = relOf(f.newUri.fsPath);
          if (!toRel) continue;
          await service.extractFile(toRel);
          const text = await readFile(toRel);
          if (text) service.refreshTamperBaseline(toRel, text);
          void fromRel;
        }
        service.save();
        service.notifyGraph();
      } finally {
        scanning = false;
      }
    });
    if (renameDisposable) context.subscriptions.push(renameDisposable);
  } catch {
    /* onDidRenameFiles unavailable */
  }

  // ---- chat participant (/init) ------------------------------------------------

  try {
    const participant = chat.createChatParticipant('code_modules.chat', async (request, _ctx, stream) => {
      if (request.command === 'init' || request.prompt.trim().startsWith('/init')) {
        stream.markdown('**code_modules /init** — scanning bottom-up, generating metadata + default locks…\n\n');
        const r = await runInitScan();
        stream.markdown(`\n✅ ${r}: \`.nodes/index.json\` written.`);
        return { metadata: { command: 'init' } };
      }
      const hits = searchNodes(service.store.get(), request.prompt, 8);
      if (!hits.length) {
        stream.markdown('No matching nodes yet — run `/init` first, or ask about a symbol name.');
        return { metadata: {} };
      }
      for (const h of hits) {
        const n = h.node;
        stream.markdown(
          `**${n.symbolPath}** — ${n.kind}${n.locked ? ' 🔒' : ''} (${n.tags.join(', ') || 'no tags'})\n\n` +
            `${n.meta?.userSummary ?? 'No metadata yet.'}\n\n\`${n.id}\`\n\n---\n\n`
        );
      }
      return { metadata: {} };
    });
    participant.followupProvider = {
      provideFollowups: () => [{ prompt: '/init', title: 'Scan workspace with code_modules' }],
    };
    context.subscriptions.push(participant);
  } catch (err) {
    console.error('[code_modules] chat participant unavailable:', String(err));
  }

  // ---- commands ------------------------------------------------------------------

  context.subscriptions.push(
    commands.registerCommand('code_modules.openGraph', async () => {
      await view.open();
      await router.handle({ type: 'ready' });
    }),
    commands.registerCommand('code_modules.refresh', async () => {
      await service.ensureScanned();
      service.save();
      service.notifyGraph();
      await router.handle({ type: 'refresh', full: true });
    }),
    commands.registerCommand('code_modules.init', async () => runInitScan()),
    commands.registerCommand('code_modules.showLocks', () => {
      const locked = Object.values(service.store.get().nodes).filter((n) => n.locked);
      void window
        .showQuickPick(locked.map((n) => ({ label: `${n.id}`, detail: n.lockReason || 'locked' })), {
          placeHolder: `${locked.length} locked node(s) — the agent cannot modify these; unlock one-click from the graph card`,
        })
        .then((pick) => {
          if (pick) {
            const id = pick.label;
            service.toggleLock(id);
            service.save();
            void router.handle({ type: 'refresh', full: true });
          }
        });
    })
  );

  void estimateTokens(''); // keep import used (budget estimator exposed to future settings UI)
  void TsExtractor;

  void service.ensureScanned().then(() => {
    service.save();
    service.notifyGraph();
  });

  return { service };
}

export function deactivate(): void {
  /* handled via subscriptions */
}
