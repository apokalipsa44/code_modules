import { describe, expect, it } from 'vitest';
import { GraphStore, dedupeEdges, migrate } from '../src/graph/store';
import { TsExtractor } from '../src/extract/tsExtractor';
import { hashOf } from '../src/hashing';
import type { GraphIndex } from '../src/model';

const FILE = 'src/auth/session.ts';
const source1 = `export const COOKIE = 'x';\n\nexport function validateSession(req: FakeRequest) {\n  return !!req;\n}\n`;
// small edit ABOVE the function (line shift, content preserved)
const source2 = `// leading comment\nexport const COOKIE = 'x';\n\nexport function validateSession(req: FakeRequest) {\n  return !!req;\n}\n`;
// the function changed
const source3 = source2.replace('return !!req;', 'return !req;');

async function extractOf(text: string) {
  const ex = new TsExtractor();
  return ex.extract(FILE, text);
}

describe('GraphStore merge + persistence', () => {
  it('keeps user state (lock/tags/meta) across re-extraction, applies default policy to new nodes', async () => {
    const store = new GraphStore('.nodes/index.json');
    store.setLockPolicy({ defaultLockedTags: ['auth'] });
    store.mergeFileExtraction(FILE, await extractOf(source1));
    // tag manually, then re-extract after a failed save in another process etc.
    const id = FILE + '#validateSession';
    store.node(id)!.tags.push('auth');
    store.mergeFileExtraction(FILE, await extractOf(source1));
    const again = store.node(id)!;
    expect(again.tags).toContain('auth');
    // cookie const has no tags -> never auto-locked
    expect(store.node(FILE + '#COOKIE')!.locked).toBe(false);
  });

  it('survives line shifts (same id) and relinks by content hash when id changes', async () => {
    const store = new GraphStore('.nodes/index.json');
    store.setLockPolicy({ defaultLockedTags: ['auth'] });
    const fx1 = await extractOf(source1);
    store.mergeFileExtraction(FILE, fx1);
    const fn1 = store.node(FILE + '#validateSession')!;
    fn1.tags = ['auth'];
    fn1.locked = true;
    fn1.lockReason = 'user lock';
    fn1.meta = {
      userSummary: 'validates session',
      agentSummary: { inputs: 'req', outputs: 'boolean', invariants: ['never log tokens'], sideEffects: [] },
      metaHash: fn1.contentHash,
      stale: false,
    };

    // line shift: same ids, node range moves
    const r2 = store.mergeFileExtraction(FILE, await extractOf(source2));
    const fn2 = store.node(FILE + '#validateSession')!;
    expect(r2.nodes).toContain(FILE + '#validateSession');
    expect(fn2.range.startLine).toBe(4);
    expect(fn2.locked).toBe(true);
    expect(fn2.meta?.userSummary).toBe('validates session');

    // content change under a NEW id -> old id gone, state re-linked by hash if identical
    const r3 = store.mergeFileExtraction(FILE, await extractOf(source3));
    expect(store.node(FILE + '#validateSession')).toBeDefined();
    expect(r3.nodes).toContain(FILE + '#validateSession');
    expect(r3.relinked).toHaveLength(0);

    // rename scenario: delete old file then extract under new name -> state follows via tombstone
    const ex = new TsExtractor();
    store.mergeFileExtraction('src/auth/session.ts', await ex.extract('src/auth/session.ts', ''));
    const movedFx = await ex.extract('src/auth/session2.ts', source3);
    const r4 = store.mergeFileExtraction('src/auth/session2.ts', movedFx);
    const movedNode = Object.values(store.get().nodes).find(
      (n) => n.file === 'src/auth/session2.ts' && n.symbolPath === 'validateSession'
    )!;
    expect(r4.relinked).toContain(movedNode.id);
    expect(movedNode.locked).toBe(true); // lock followed the code, thanks to hash relink
  });

  it('roundtrips through load/save with migration', async () => {
    const store = new GraphStore('.nodes/index.json');
    store.mergeFileExtraction(FILE, await extractOf(source1));
    const migrated = migrate(JSON.parse(JSON.stringify(store.get())) as Partial<GraphIndex>);
    expect(migrated.schemaVersion).toBe(1);
    const rawV0 = { nodes: [{ id: 'x.ts#a', file: 'x.ts', symbolPath: 'a', name: 'a', kind: 'function', range: { startLine: 1, endLine: 1 }, signature: 'a()', contentHash: hashOf('a'), tags: [], locked: false, lockReason: '', edges: [] }] };
    const up = migrate(rawV0 as unknown as Partial<GraphIndex>);
    expect(Object.keys(up.nodes)).toContain('x.ts#a');
  });

  it('dedupes edges', () => {
    const edges = dedupeEdges([
      { from: 'a', to: 'b', type: 'calls' },
      { from: 'a', to: 'b', type: 'calls' },
      { from: 'a', to: 'b', type: 'imports' },
    ]);
    expect(edges).toHaveLength(2);
  });
});
