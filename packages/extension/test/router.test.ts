import { describe, expect, it } from 'vitest';
import { ExtensionRouter, type RouterDeps } from '../src/router';
import type { FromExtensionToWebview, GraphNodeDTO } from '@code_modules/core';

const node: GraphNodeDTO = {
  id: 'src/x.ts#hello',
  label: 'hello',
  kind: 'function',
  file: 'src/x.ts',
  tags: ['core'],
  locked: false,
  lockReason: '',
  summary: 'says hi',
  stale: false,
  signature: 'function hello(): void',
  startLine: 1,
  endLine: 3,
};

function makeDeps(overrides: Partial<RouterDeps> = {}): RouterDeps & { revealed: string[] } {
  const revealed: string[] = [];
  return {
    revealed,
    getGraph: () => ({ nodes: [node], edges: [], layers: ['core'] }),
    search: (q) => ({ nodes: q ? [node] : [], edges: [], layers: [] }),
    expand: () => ({ nodes: [node], edges: [], layers: ['core'] }),
    readNodeSource: async (_id) => ({ content: 'function hello() {}', startLine: 1, file: 'src/x.ts' }),
    saveNodeEdit: async (_id, content) => {
      if (content.includes('hacked')) return { ok: false, error: 'lock violation' };
      return { ok: true };
    },
    toggleLock: () => true,
    reveal: (id) => revealed.push(id),
    runAgent: async (roots, instruction) => `ran with roots=${roots.join('|')} instruction=${instruction}`,
    initScan: async () => 'done',
    ...overrides,
  } as RouterDeps & { revealed: string[] };
}

function makeSender(): { out: FromExtensionToWebview[]; send: (m: FromExtensionToWebview) => void } {
  const out: FromExtensionToWebview[] = [];
  return { out, send: (m) => out.push(m) };
}

describe('extension router (extension→webview round trip)', () => {
  it('ready → graphUpdated echoes the graph', async () => {
    const deps = makeDeps();
    const { out, send } = makeSender();
    const router = new ExtensionRouter(deps, send, { depth: 2 });
    await router.handle({ type: 'ready' });
    expect(out[0]?.type).toBe('graphUpdated');
    if (out[0]?.type === 'graphUpdated') {
      expect(out[0].nodes[0]?.id).toBe('src/x.ts#hello');
      expect(out[0].layers).toContain('core');
    }
  });

  it('search intent → filtered graph push', async () => {
    const deps = makeDeps();
    const { out, send } = makeSender();
    const router = new ExtensionRouter(deps, send, { depth: 2 });
    await router.handle({ type: 'search', query: 'hello', depth: 1 });
    if (out[0]?.type === 'graphUpdated') expect(out[0].nodes).toHaveLength(1);
    else expect(out[0]?.type).toBe('graphUpdated');
  });

  it('saveEdit propagates lock violation as an error message', async () => {
    const deps = makeDeps();
    const { out, send } = makeSender();
    const router = new ExtensionRouter(deps, send, { depth: 2 });
    await router.handle({ type: 'saveEdit', id: 'src/x.ts#hello', content: 'function hello() { hacked; }' });
    expect(out.some((m) => m.type === 'error' && m.message.includes('lock violation'))).toBe(true);
  });

  it('startEdit pushes nodeContent with the real source', async () => {
    const { out, send } = makeSender();
    const router = new ExtensionRouter(makeDeps(), send, { depth: 2 });
    await router.handle({ type: 'startEdit', id: 'src/x.ts#hello' });
    expect(out[0]?.type).toBe('nodeContent');
    if (out[0]?.type === 'nodeContent') expect(out[0].content).toContain('function hello');
  });

  it('agentRun returns the reply and pushes agentDone', async () => {
    const { out, send } = makeSender();
    const router = new ExtensionRouter(makeDeps(), send, { depth: 2 });
    await router.handle({ type: 'agentRun', rootIds: ['src/x.ts#hello'], instruction: 'clean this' });
    expect(out.some((m) => m.type === 'agentDone' && m.reply.includes('instruction=clean this'))).toBe(true);
  });

  it('revealNode reaches the editor service', async () => {
    const deps = makeDeps();
    const { send } = makeSender();
    const router = new ExtensionRouter(deps, send, { depth: 2 });
    await router.handle({ type: 'revealNode', id: 'src/x.ts#hello' });
    expect(deps.revealed).toEqual(['src/x.ts#hello']);
  });
});
