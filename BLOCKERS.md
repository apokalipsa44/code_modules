# BLOCKERS

- **@vscode/test-electron integration run** (F5-launch style test) cannot execute in this sandbox: no X display and no passwordless sudo to install `xvfb` (`sudo -n apt-get install -y xvfb` → "interactive authentication is required"). All logic that does not require the live VS Code host is covered by 31+ vitest suites (core + extension router). `packages/extension/test/router.test.ts` covers the extension↔webview round-trip contract with fakes. To run the real integration on a dev machine: `xvfb-run npm test` after `npm run build`.
- **Claude Agent SDK live E2E**: requires an Anthropic API key (not provided). Behind `ModelProvider`/`DirectAgent` interfaces: offline `mock` provider is default when keyless; SDK path is implemented (MCP tool server + `canUseTool` final gate) but cannot be exercised here. Documented in README.
- Packaging (`.vsix` via vsce) intentionally not done per YOLO rules (no publishing).
