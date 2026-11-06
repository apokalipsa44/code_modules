import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

const req = createRequire(__filename);

export type GrammarKind = 'typescript' | 'tsx';

let initPromise: Promise<unknown> | null = null;

function ensureInit(): Promise<unknown> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

const languageCache = new Map<GrammarKind, Promise<Language>>();

interface MaybeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}

function getFs(): MaybeFs | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs: MaybeFs = require('node:fs');
    return fs;
  } catch {
    return null;
  }
}

/**
 * Resolve the prebuilt wasm grammar. Under esbuild bundling `require.resolve`
 * of a data file resolves at runtime relative to the bundle location, so we
 * probe those candidates with fs when resolution fails.
 */
function wasmCandidates(kind: GrammarKind): string[] {
  const wasm = kind === 'tsx' ? 'tree-sitter-tsx.wasm' : 'tree-sitter-typescript.wasm';
  const rel = `node_modules/tree-sitter-wasms/out/${wasm}`;
  const tries: string[] = [];
  try {
    tries.push(req.resolve('tree-sitter-wasms/out/' + wasm));
  } catch {
    /* ignore */
  }
  let cwd = __filename;
  for (let i = 0; i < 8; i++) {
    cwd = cwd.slice(0, cwd.lastIndexOf('/'));
    tries.push(cwd + '/' + rel);
  }
  return tries;
}

export async function getLanguage(kind: GrammarKind): Promise<Language> {
  let p = languageCache.get(kind);
  if (!p) {
    p = (async () => {
      await ensureInit();
      const fs = getFs();
      let lastError: unknown = null;
      for (const candidate of wasmCandidates(kind)) {
        try {
          if (fs && !candidate.startsWith('file:')) {
            if (!fs.existsSync(candidate)) continue;
            const data = fs.readFileSync(candidate);
            return await Language.load(data as unknown as Parameters<typeof Language.load>[0]);
          }
          return await Language.load(
            candidate as unknown as Parameters<typeof Language.load>[0]
          );
        } catch (err) {
          lastError = err;
        }
      }
      throw new Error(`code_modules: failed to load ${kind} grammar: ${String(lastError)}`);
    })();
    languageCache.set(kind, p);
  }
  return p;
}

export async function getParser(kind: GrammarKind): Promise<Parser> {
  await ensureInit();
  const parser = new Parser();
  parser.setLanguage(await getLanguage(kind));
  return parser;
}

export function grammarForFile(fileName: string): GrammarKind {
  return fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? 'tsx' : 'typescript';
}
