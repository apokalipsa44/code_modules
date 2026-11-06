import { describe, expect, it } from 'vitest';
import { runScan, markStale, isStale, heuristicMetaProvider, type MetaProvider } from '../src/meta/generate';
import { emptyIndex, type GraphIndex } from '../src/model';
import { LockEngine } from '../src/locks/engine';
import { buildSubgraphContext } from '../src/graph/context';

function makeGraph(): GraphIndex {
  const index = emptyIndex();
  index.nodes = {
    'src/db.ts#getDb': { id: 'src/db.ts#getDb', file: 'src/db.ts', symbolPath: 'getDb', name: 'getDb', kind: 'function', range: { startLine: 1, endLine: 5 }, signature: 'function getDb(): Db', contentHash: 'sha256:db', tags: ['db'], locked: false, lockReason: '' },
    'src/auth.ts#getSession': { id: 'src/auth.ts#getSession', file: 'src/auth.ts', symbolPath: 'getSession', name: 'getSession', kind: 'function', range: { startLine: 1, endLine: 5 }, signature: 'function getSession(req: Req): Promise<Session>', contentHash: 'sha256:auth', tags: ['auth'], locked: false, lockReason: '' },
    'src/api.ts#userSettingsHandler': { id: 'src/api.ts#userSettingsHandler', file: 'src/api.ts', symbolPath: 'userSettingsHandler', name: 'userSettingsHandler', kind: 'route', range: { startLine: 1, endLine: 10 }, signature: 'function userSettingsHandler(req: Req): Promise<Res>', contentHash: 'sha256:api', tags: ['api'], locked: false, lockReason: '' },
  };
  index.edges = [
    { from: 'src/api.ts#userSettingsHandler', to: 'src/auth.ts#getSession', type: 'calls' },
    { from: 'src/auth.ts#getSession', to: 'src/db.ts#getDb', type: 'calls' },
  ];
  return index;
}

describe('/init scanning (bottom-up, resumable, budgeted)', () => {
  const files: Record<string, string> = {
    'src/db.ts': 'function getDb(): Db { return db; }',
    'src/auth.ts': 'function getSession(req: Req): Promise<Session> { return null as never; }',
    'src/api.ts': 'function userSettingsHandler(req: Req): Promise<Res> { return null as never; }',
  };

  it('processes leaves first and reuses their summaries', async () => {
    const index = makeGraph();
    const orderSeen: string[] = [];
    void orderSeen;
    const p: MetaProvider = {
      async summarize(node, context) {
        orderSeen.push(node.id);
        expect(context.length).toBeGreaterThanOrEqual(0);
        return {
          userSummary: `${node.name}: ${node.id}`,
          agentSummary: { inputs: 'req', outputs: 'promise', invariants: ['never log tokens'], sideEffects: [] },
          tags: node.file.includes('auth') ? ['auth'] : ['core'],
        };
      },
    };
    const res = await runScan(index, p, async (f) => files[f]!, { skipFresh: true, budgetTokens: 0 });
    expect(orderSeen[0]).toBe('src/db.ts#getDb'); // leaf first
    expect(orderSeen[1]).toBe('src/auth.ts#getSession');
    expect(orderSeen[2]).toBe('src/api.ts#userSettingsHandler');
    expect(res.processed).toHaveLength(3);
    expect(index.nodes['src/db.ts#getDb']!.meta!.userSummary).toContain('getDb');
    expect(index.nodes['src/db.ts#getDb']!.meta!.agentSummary.invariants).toContain('never log tokens');
    expect(res.proposedLockTags).toContain('auth');
  });

  it('skips fresh nodes (rerun only regenerates changed), marks stale, budget caps', async () => {
    const index = makeGraph();
    const files2: Record<string, string> = { ...files };
    const p = heuristicMetaProvider();
    await runScan(index, p, async (f) => files2[f]!, { skipFresh: true, budgetTokens: 0 });
    // rerun -> everything fresh, nothing regenerated
    const seen: string[] = [];
    const _res2 = await runScan(index, p, async (f) => files2[f]!, {
      skipFresh: true,
      budgetTokens: 0,
      onProgress: (_d, _t, id) => seen.push(id),
    });
    expect(seen).toHaveLength(0);
    // change one node's hash -> marked stale
    const node = index.nodes['src/auth.ts#getSession']!;
    node.contentHash = 'sha256:CHANGED';
    expect(isStale(node)).toBe(true);
    expect(markStale(index)).toContain('src/auth.ts#getSession');
    // rerun regenerates only the stale node
    const seen3: string[] = [];
    const res3 = await runScan(index, p, async (f) => files2[f]!, {
      skipFresh: true,
      budgetTokens: 0,
      onProgress: (_d, _t, id) => seen3.push(id),
    });
    expect(seen3).toEqual(['src/auth.ts#getSession']);
    expect(res3.processed).toHaveLength(1);
    // budget cap stops the scan early
    const seen4: string[] = [];
    const res4 = await runScan(index, p, async (f) => files2[f]!, {
      skipFresh: false,
      budgetTokens: 10,
      onProgress: (_d, _t, id) => seen4.push(id),
    });
    expect(res4.budgetExceeded).toBe(true);
    expect(seen4.length).toBeLessThan(3);
  });

  it('subgraph context gives editable nodes in full and locked nodes as contracts with stale warnings', async () => {
    const index = makeGraph();
    const engine = new LockEngine();
    engine.attach(index);
    engine.setLocked('src/auth.ts#getSession', true, 'default policy: auth');
    index.nodes['src/auth.ts#getSession']!.meta = {
      userSummary: 'Session lookup',
      agentSummary: { inputs: 'req', outputs: 'Session', invariants: [], sideEffects: [] },
      metaHash: 'sha256:OLD',
      stale: false,
    };
    const ctx = buildSubgraphContext(index, ['src/api.ts#userSettingsHandler'], { depth: 2, lockPolicyMatching: null }, (n) => engine.effectivelyLocked(n));
    expect(ctx.contracts.map((c) => c.nodeId)).toContain('src/auth.ts#getSession');
    expect(ctx.full.map((n) => n.id)).toContain('src/api.ts#userSettingsHandler');
    expect(ctx.full.map((n) => n.id)).not.toContain('src/auth.ts#getSession');
    expect(ctx.contracts.find((c) => c.nodeId === 'src/auth.ts#getSession')!.staleWarning).toContain('STALE');
  });
});
