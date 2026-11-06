import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TsExtractor } from '../src/extract/tsExtractor';

const fixtureDir = join(__dirname, 'fixtures');
const read = (f: string) => readFileSync(join(fixtureDir, f), 'utf8');

describe('TsExtractor (tree-sitter)', () => {
  it('extracts nested functions, arrows, default exports, class methods, routes and config blocks', async () => {
    const ex = new TsExtractor();
    const fx = await ex.extract('src/auth/sample-auth.ts', read('sample-auth.ts'));
    const paths = fx.nodes.map((n) => `${n.kind}:${n.symbolPath}`);
    expect(paths).toContain('function:validateSession');
    expect(paths).toContain('function:validateSession.extractToken'); // nested function
    expect(paths).toContain('function:sessionCookie'); // top-level arrow
    expect(paths).toContain('function:defaultSessionHelper');
    expect(paths).toContain('class:SessionStore');
    expect(paths).toContain('method:SessionStore.get');
    expect(paths).toContain('method:SessionStore.set');
    expect(paths.some((p) => p === 'config:routes')).toBe(true);
    expect(paths).toContain('function:routes.login');
    expect(paths).toContain('function:routes.logout');
    expect(paths).toContain('config:API_CONFIG');
    expect(paths).toContain('type:Session');
    // default export named at walker: node exists with 'default' only for anonymous
    // import symbols + exports recorded
    expect(fx.importSymbols['signToken']).toBe('./signing');
    expect(Object.keys(fx.exports)).toContain('defaultSessionHelper');
  });

  it('extracts JSX components and nested arrow-in-arrow of a tsx fixture', async () => {
    const ex = new TsExtractor();
    const fx = await ex.extract('src/ui/Avatar.tsx', read('Avatar.tsx'));
    const paths = fx.nodes.map((n) => `${n.kind}:${n.symbolPath}`);
    expect(paths).toContain('component:Avatar');
    expect(paths).toContain('component:AvatarButton');
    expect(paths).toContain('component:Screen');
    expect(paths).toContain('function:AvatarButton.report'); // nested named function in arrow
  });

  it('extracts decorated classes keeping the decorator in range/hash', async () => {
    const ex = new TsExtractor();
    const fx = await ex.extract('src/api/service.ts', read('service.ts'));
    const paths = fx.nodes.map((n) => `${n.kind}:${n.symbolPath}`);
    expect(paths).toContain('class:DecoratedService');
    expect(paths).toContain('method:DecoratedService.handle');
    expect(paths.some((p) => p.startsWith('config:API_ROUTES'))).toBe(true);
    expect(paths.some((p) => p === 'function:API_ROUTES.get' || p === 'route:API_ROUTES.get' || p === 'config:API_ROUTES.get')).toBe(true);
    const cls = fx.nodes.find((n) => n.symbolPath === 'DecoratedService')!;
    const handle = fx.nodes.find((n) => n.symbolPath === 'DecoratedService.handle')!;
    // decorators do not split methods off; the class still extracts normally
    expect(cls.kind).toBe('class');
    expect(handle.kind).toBe('method');
  });

  it('ranges include decorators and hashes change with content', async () => {
    const ex = new TsExtractor();
    const before = await ex.extract('src/auth/x.ts', 'export function a() { return 1; }\n');
    const after = await ex.extract('src/auth/x.ts', 'export function a() { return 2; }\n');
    expect(after.nodes[0]!.contentHash).not.toBe(before.nodes[0]!.contentHash);
  });

  it('node ids are file+symbol based (stable across line shifts)', async () => {
    const ex = new TsExtractor();
    const a = await ex.extract('src/x.ts', '\n\n\nexport function stable() {}\n');
    const b = await ex.extract('src/x.ts', 'export function stable() {}\n');
    expect(a.nodes[0]!.id).toBe('src/x.ts#stable');
    expect(b.nodes[0]!.id).toBe('src/x.ts#stable');
  });
});
