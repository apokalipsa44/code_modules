# DECISIONS — NodeCode

- **web-tree-sitter + tree-sitter-wasms**: prebuilt WASM grammars load in Node (extension host) AND vitest without a build step. Rationale: zero native compile, works in CI.
- **Node ids**: `<posix file>#<symbolPath>`; symbolPath dotted (`Class.method`, `parent.nested`). Stable across line shifts. Rename/move reclaim state (lock/tags/meta) via content-hash "tombstones" kept in the GraphStore when a node disappears; relinked when identical code reappears elsewhere.
- **Descendant locking**: a node inside a locked node (dotted prefix, same file) is *effectively locked* — replacing an unlocked ancestor that contains locked code is rejected by `LockEngine.checkReplacement`. Rationale: range-based locks are only meaningful if they can't be erased by ancestor replacement.
- **Agent loop lives in core** (`AgentRunner`), provider is pull-based (`nextTurn(state)`), so lock enforcement cannot be circumvented by model-run tool loops (e.g. SDK-driven bash). The Claude Agent SDK adapter pumps its query loop behind this same interface and never registers raw file/bash tools.
- **Edits**: core defines `EditApplier` (line-range `SourceEdit[]`); the extension implements it with `WorkspaceEdit`, so undo/redo/dirty-state are native. Agent edits auto-apply by default (per spec), each edit is returned with before/after for diff logging.
- **Breakage guard**: after `edit_node`, dependents (transitive, bounded) are re-checked with the configured check runner (tsc/vitest, extension-wired); if failing diagnostics touch a file containing a locked dependent → automatic rollback (restoring old content through the applier) + diagnostics returned to the agent.
- **Mock provider**: `MockProvider`/`ScriptedProvider` ship in core; used by tests and as offline default when no API key is configured (documented in README).
- **Layers/tags**: tags are free-form; default lock policy `defaultLockedTags: ['auth','payments']` auto-locks new matching nodes at merge time.
- **KR format `.nodes/index.json`**: `schemaVersion: 1`; loader migrates v0-style array nodes forward; newer versions hard-fail with a clear error.
- **Routes detection heuristic**: uppercase HTTP verb names (`GET/POST/...`) or `api`-path/controller-suffix files with get/post/... names → kind `route`.
- **ESLint v8 + flat-ish .eslintrc**: kept simple (recommended set, TS parser) to avoid churn; formatting via Prettier.
- **search scoring**: multi-signal additive (camelCase word-boundary > substring > subsequence; tags/file/summary stack), deterministic tiebreak by id. Kept pure-core so the extension can add LSP workspace-symbol hits on top.
- **The webview holds zero business logic**: typed protocol in `core/src/protocol.ts` (shared source of truth), webview renders DTOs and sends intents only.
- **CI**: single `verify` job (build → lint → typecheck → vitest) on ubuntu + node 20; F5/electron integration intentionally left to dev machines (see BLOCKERS). F5 launch config targets `examples/demo` so first run shows a populated graph.
- **Demo sample**: static TS/TSX sample in `examples/demo` rather than generated fixtures so users can point the extension at a real-looking mini-codebase without any deps.
