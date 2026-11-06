import { describe, expect, it } from 'vitest';
import { searchNodes } from '../src/graph/search';
import { expandSubgraph, allLayers, neighbors } from '../src/graph/order';
import { buildFallbackEdges } from '../src/extract/edges';
import { emptyIndex, type GraphIndex } from '../src/model';

describe('search', () => {
  const index: GraphIndex = buildTinyIndex();
  it('ranks symbol exact > contains > tag > summary', () => {
    const hits = searchNodes(index, 'user settings');
    expect(hits[0]!.node.id).toBe('src/screens/UserSettingsScreen.tsx#UserSettingsScreen');
    const tagHits = searchNodes(index, 'cookies').map((h) => h.node.id);
    expect(tagHits).toContain('src/auth.ts#validateSession');
    expect(searchNodes(index, '')).toHaveLength(0);
  });
  it('layer filter keeps only nodes carrying a shown layer (roots always kept)', () => {
    const sub = expandSubgraph(index, ['src/api.ts#userSettingsHandler'], 3, ['auth']);
    const ids = sub.nodes.map((n) => n.id);
    expect(ids).toContain('src/api.ts#userSettingsHandler');
    expect(sub.nodes.some((n) => n.tags.includes('auth') || ids.includes('src/api.ts#userSettingsHandler'))).toBe(true);
    expect(sub.nodes.every((n) => n.tags.includes('auth') || n.tags.includes('api') || n.id.endsWith('userSettingsHandler'))).toBe(true);
    expect(allLayers(index)).toEqual(expect.arrayContaining(['auth', 'cookies', 'api', 'ui']));
  });
  it('depth expansion: depth 0 = roots, depth 1 = +direct deps', () => {
    const d0 = expandSubgraph(index, ['src/api.ts#userSettingsHandler'], 0);
    expect(d0.nodes).toHaveLength(1);
    const d1 = expandSubgraph(index, ['src/api.ts#userSettingsHandler'], 1);
    expect(d1.nodes.map((n) => n.id)).toContain('src/auth.ts#validateSession');
    // deps-direction only: other dependents of validateSession are not pulled in
    expect(expandSubgraph(index, ['src/api.ts#userSettingsHandler'], 2).nodes.map((n) => n.id)).not.toContain('src/auth.ts#loginForm');
    expect(neighbors(index, 'src/auth.ts#validateSession', 'dependents')).toContain('src/api.ts#userSettingsHandler');
  });
});

describe('fallback edges via import analysis', () => {
  it('links a route to its handler through imports', async () => {
    const { TsExtractor } = await import('../src/extract/tsExtractor');
    const ex = new TsExtractor();
    const fs0 = 'export function validateSession(req: FakeRequest) { return req; }';
    const fw0 = 'import { validateSession } from "../auth/session";\nexport function userSettingsHandler(req: FakeRequest) { return validateSession(req); }';
    const [fs, fw] = await Promise.all([ex.extract('src/auth/session.ts', fs0), ex.extract('src/api/userSettings.ts', fw0)]);
    const map = new Map([
      [fs.file, fs],
      [fw.file, fw],
    ]);
    const io = { exists: (p: string) => ['src/auth/session.ts'].includes(p) };
    const edges = buildFallbackEdges(map, io);
    expect(edges).toContainEqual({
      from: 'src/api/userSettings.ts#userSettingsHandler',
      to: 'src/auth/session.ts#validateSession',
      type: 'imports',
    });
  });
});

export function buildTinyIndex(): GraphIndex {
  const index = emptyIndex();
  index.nodes = {
    'src/api.ts#userSettingsHandler': {
      id: 'src/api.ts#userSettingsHandler', file: 'src/api.ts', symbolPath: 'userSettingsHandler', name: 'userSettingsHandler', kind: 'route',
      range: { startLine: 1, endLine: 10 }, signature: 'function userSettingsHandler(req: Req): Promise<Res>', contentHash: 'h1', tags: ['api'], locked: false, lockReason: '',
    },
    'src/auth.ts#validateSession': {
      id: 'src/auth.ts#validateSession', file: 'src/auth.ts', symbolPath: 'validateSession', name: 'validateSession', kind: 'function',
      range: { startLine: 1, endLine: 5 }, signature: 'function validateSession(req: Req): Promise<Session | null>', contentHash: 'h2', tags: ['auth', 'cookies'], locked: false, lockReason: '',
    },
    'src/auth.ts#loginForm': {
      id: 'src/auth.ts#loginForm', file: 'src/auth.ts', symbolPath: 'loginForm', name: 'loginForm', kind: 'component',
      range: { startLine: 10, endLine: 30 }, signature: 'function loginForm(props: Props): JSX.Element', contentHash: 'h3', tags: ['auth', 'ui'], locked: false, lockReason: '',
    },
    'src/screens/UserSettingsScreen.tsx#UserSettingsScreen': {
      id: 'src/screens/UserSettingsScreen.tsx#UserSettingsScreen', file: 'src/screens/UserSettingsScreen.tsx', symbolPath: 'UserSettingsScreen', name: 'UserSettingsScreen', kind: 'component',
      range: { startLine: 1, endLine: 50 }, signature: 'function UserSettingsScreen(props: Props): JSX.Element', contentHash: 'h4', tags: ['ui', 'settings'], locked: false, lockReason: '',
    },
  };
  index.edges = [
    { from: 'src/screens/UserSettingsScreen.tsx#UserSettingsScreen', to: 'src/api.ts#userSettingsHandler', type: 'calls' },
    { from: 'src/api.ts#userSettingsHandler', to: 'src/auth.ts#validateSession', type: 'calls' },
    { from: 'src/auth.ts#loginForm', to: 'src/auth.ts#validateSession', type: 'calls' },
  ];
  return index;
}

export {};
