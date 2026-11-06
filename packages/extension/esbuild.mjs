import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isWatch = process.argv.includes('--watch');

// web-tree-sitter and the Claude SDK stay external: they load WASM / dynamic
// code at runtime from node_modules (dev-first packaging; see README).
const common = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode', 'web-tree-sitter', '@anthropic-ai/claude-agent-sdk', 'tree-sitter-wasms'],
  sourcemap: true,
  logLevel: 'info',
};

function copyWebviewDist() {
  const src = path.resolve(import.meta.dirname, '../webview/dist');
  const dst = path.resolve(import.meta.dirname, 'dist/webview');
  if (!fs.existsSync(src)) {
    console.log('[code_modules] webview dist missing — run `npm run build -w packages/webview` first');
    return;
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log('[code_modules] copied webview dist ->', dst);
}

if (isWatch) {
  const ctx = await esbuild.context(common);
  await ctx.watch();
  console.log('[code_modules] esbuild watching...');
} else {
  await esbuild.build(common);
  copyWebviewDist();
}
