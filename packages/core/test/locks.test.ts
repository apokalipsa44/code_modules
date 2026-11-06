import { describe, expect, it } from 'vitest';
import { LockEngine, applyDefaultLocks } from '../src/locks/engine';
import { emptyIndex, type CodeNode, type GraphIndex } from '../src/model';
import { buildContract } from '../src/locks/contract';

function node(partial: Partial<CodeNode> & { id: string }): CodeNode {
  return {
    id: partial.id,
    file: partial.file ?? 'src/x.ts',
    symbolPath: partial.symbolPath ?? partial.id.split('#')[1] ?? '',
    name: partial.name ?? '',
    kind: partial.kind ?? 'function',
    range: partial.range ?? { startLine: 1, endLine: 10 },
    signature: partial.signature ?? '',
    contentHash: partial.contentHash ?? 'sha256:x',
    tags: partial.tags ?? [],
    locked: partial.locked ?? false,
    lockReason: partial.lockReason ?? '',
    meta: partial.meta,
  };
}

describe('LockEngine', () => {
  function makeIndex(): GraphIndex {
    const index = emptyIndex();
    index.nodes = {
      'src/outer.ts#outer': node({ id: 'src/outer.ts#outer', symbolPath: 'outer', range: { startLine: 1, endLine: 20 } }),
      'src/outer.ts#outer.inner': node({ id: 'src/outer.ts#outer.inner', symbolPath: 'outer.inner', range: { startLine: 3, endLine: 6 } }),
      'src/auth.ts#authenticate': node({ id: 'src/auth.ts#authenticate', file: 'src/auth.ts', symbolPath: 'authenticate', locked: true, lockReason: 'default policy: auth', tags: ['auth'] }),
      'src/auth.ts#authenticate.hmac': node({ id: 'src/auth.ts#authenticate.hmac', file: 'src/auth.ts', symbolPath: 'authenticate.hmac', range: { startLine: 5, endLine: 9 } }),
      'src/auth.ts#routes.logout': node({ id: 'src/auth.ts#routes.logout', file: 'src/auth.ts', symbolPath: 'routes.logout', range: { startLine: 30, endLine: 33 } }),
    };
    return index;
  }

  it('locked node cannot be edited; unknown rejected', () => {
    const engine = new LockEngine();
    engine.attach(makeIndex());
    expect(engine.canEdit('src/auth.ts#authenticate')).toMatchObject({ allowed: false });
    expect(engine.canEdit('nope')).toMatchObject({ allowed: false });
    expect(engine.canEdit('src/outer.ts#outer')).toMatchObject({ allowed: true });
  });

  it('descendants of locked nodes are effectively locked (defense in depth)', () => {
    const engine = new LockEngine();
    engine.attach(makeIndex());
    expect(engine.effectivelyLocked(engine.byId('src/auth.ts#authenticate.hmac')!)).toBe(true);
    expect(engine.canEdit('src/auth.ts#authenticate.hmac').allowed).toBe(false);
  });

  it('checkReplacement rejects edits that would delete locked descendants', () => {
    const engine = new LockEngine();
    const index = makeIndex();
    index.nodes['src/outer.ts#outer.inner']!.locked = true;
    engine.attach(index);
    expect(engine.checkReplacement('src/outer.ts#outer', 'function outer() { return 1; }').allowed).toBe(false);
    expect(engine.checkReplacement('src/outer.ts#outer', 'function outer() { const inner = () => 1; return inner(); }').allowed).toBe(true);
  });

  it('canInsertAtLine guards locked ranges', () => {
    const engine = new LockEngine();
    engine.attach(makeIndex());
    expect(engine.canInsertAtLine('src/auth.ts', 5).allowed).toBe(false);
    expect(engine.canInsertAtLine('src/auth.ts', 50).allowed).toBe(true);
    expect(engine.canInsertAtLine('src/free.ts', 1).allowed).toBe(true);
  });

  it('applyDefaultLocks locks nodes matching policy tags', () => {
    const n = node({ id: 'src/a.ts#login', tags: ['auth', 'api'] });
    applyDefaultLocks(n, { defaultLockedTags: ['auth'] });
    expect(n.locked).toBe(true);
    expect(n.lockReason).toContain('default policy: auth');
    const m = node({ id: 'src/a.ts#form', tags: ['ui'] });
    applyDefaultLocks(m, { defaultLockedTags: ['auth'] });
    expect(m.locked).toBe(false);
  });
});

describe('Contract generation (locked nodes expose no implementation)', () => {
  const fileText = `export function authenticate(req: Req): Promise<Auth> {
  // secret implementation must not leak
  return check(req);
}
export type Auth = { user: string };
export interface Req { token: string }
`;

  it('has signature + types + invariants but no body', () => {
    const n = node({
      id: 'src/auth.ts#authenticate',
      signature: 'function authenticate(req: Req): Promise<Auth>',
      meta: {
        userSummary: 'Authenticates a request',
        agentSummary: { inputs: 'req', outputs: 'Auth', invariants: ['never log tokens'], sideEffects: ['sets cookie'] },
        metaHash: 'sha256:x',
        stale: false,
      },
    });
    const c = buildContract(n, fileText);
    expect(c.description).toBe('Authenticates a request');
    expect(c.invariants).toContain('never log tokens');
    expect(c.sideEffects).toContain('sets cookie');
    expect(JSON.stringify(c)).toContain('Auth');
    expect(JSON.stringify(JSON.stringify(c))).not.toContain('secret implementation');
    expect(c.types.length).toBeGreaterThanOrEqual(1);
  });
});
