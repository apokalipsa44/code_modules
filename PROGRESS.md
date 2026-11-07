# PROGRESS

## Phase 1 — Skeleton ✅
- Monorepo: npm workspaces (core / extension / webview), esbuild for the extension, Vite for the webview, eslint + prettier, vitest at root.
- Typed message protocol Single source of truth: `packages/core/src/protocol.ts`.
- `code_modules: Open Graph` opens a React Flow webview (drag/zoom/minimap, dagre auto-layout).
- Round trip: `ready → graphUpdated` covered by `packages/core/test/protocol.test.ts` and `packages/extension/test/router.test.ts`.
- Note: full `@vscode/test-electron` host run blocked (no display; see BLOCKERS.md).

## Phase 2 — Node extraction ✅
- tree-sitter (web-tree-sitter + prebuilt wasms) TS/TSX extractor: functions (incl. nested+default), arrow consts, classes, methods, JSX components, route handlers, exported consts & config blocks, types; details+decorators in fixtures.
- Content hashes + stable ids (`file#symbolPath`); incremental re-extraction per changed file on save.
- 5 extractor tests.

## Phase 3 — Edges & search ✅
- Core fallback edges via import-analysis; extension merges LSP reference edges (1 level, best-effort) per save.
- Search box: ranked search (word-boundary > substring > fuzzy, tags/file/summary stacked) + depth control + layer filter chips.
- Graph push on every change; `search → graphUpdated` acceptance simulated in tests (fixture graph = settings screen + auth/api/cookies).

## Phase 4 — Node cards & editing ✅
- Cards: title, kind, tags, summary, signature; edit → Monaco (bundled, TS workers, Ctrl/Cmd+S).
- Save goes through WorkspaceEdit impl of core's `EditApplier` (undoable, native dirty state); external-change conflicts surface via error channel (`contentConflict`-style messages).
- Router tests cover edit push/save/lock-error flows.

## Phase 5 — Locks ✅
- Lock icon per card (unlock requires confirm), locked style, persisted in `.nodes/index.json`, default policy `defaultLockedTags` applied on merge.
- Engine rules: self + descendant locked; ancestor replacement can't erase locked code; create-node blocked in locked ranges.
- Defense in depth outside the agent: `onWillSaveTextDocument` tamper guard (review diff / accept) + stale marking.
- Tests: engine + ToolGate bypass attempts (direct edit, read body leak, insert inside locked range, unknown tools).

## Phase 6 — Agent with enforced locks ✅ (live SDK path pending key, see BLOCKERS)
- Core `AgentRunner` loop + `ToolGate`: only `search_nodes/read_node/edit_node/create_node/list_dependencies/list_dependents/run_checks`.
- Each handler re-checks locks; SDK adapter (extension) registers MCP tool server with the same gate + `canUseTool` final deny of unknown tools; no raw FS/bash tools exist anywhere.
- Indirect breakage guard: post-edit checks on transitive dependents; failing diagnostics touching a locked (edited-or-dependent) file → auto-rollback + diagnostics returned.
- Subgraph context: editable nodes full, locked nodes as contracts (+STALE warnings); review mode available (`code_modules.reviewEdits`) via diff approval queue.
- E2E test: "add a border to the avatar" — avatar edited, adversarial auth edit blocked, signature-breaking dependency edit rolled back.

## Phase 7 — /init scan & metadata ✅ (provider pluggable)
- `/init` (command + chat participant slash `/init`): bottom-up order, stale-skip (idempotent resume), budget cap default 750k tokens, progress + cancellation, tag proposals → adds to default lock policy, writes `.nodes/index.json`.
- Freshness: `metaHash` vs `contentHash`, `stale` flags after re-extraction, stale badges in UI and warnings in agent context.
- Acceptance tests: bottoms-up order (leaf→composer), rerun regenerates only changed, budget stops early, stale scan.

## Phase 8 — Polish & hardening ✅ (MVP-level)
- Perf: node cap, `onlyRenderVisibleElements` past 120 nodes, minimap off for big graphs, lazy edges (expand node-by-node), depth control, layer filtering/collapsing.
- Settings: depth, excludedFolders, checkCommand, reviewEdits, modelProvider, initBudgetTokens. API key only in SecretStorage/env.
- Telemetry: none, ever. Errors surfaced through webview + notifications. Docs: README, DECISIONS, BLOCKERS.
- MCP server package: deferred to IDEAS (optional per spec).
## LM Studio provider ✅ (local LLM, pattern from btfa)
- Core `OpenAiCompatProvider` (OpenAI-compatible chat/completions, no streaming)
  + `openAiChatText` for /init + `lmStudioMetaProvider` (heuristic fallback on
  errors/non-JSON) + native REST model discovery (`GET {host}/api/v1/models`,
  first loaded LLM auto-picked when `lmStudioModel` is empty).
- Extension wiring: `modelProvider = "lmstudio"` → `AgentRunner` over LM Studio
  behind the same ToolGate (locks identical); settings `lmStudioBaseUrl`
  (must end in `/v1`), `lmStudioModel`, `lmStudioTimeoutMs`.
- Tests: wire mapping (tool replay), URL/timeout/error mapping, model
  discovery preference (native API → openai-compat fallback), model ranking,
  chat-text helper. 11 new tests; full suite 48 green, lint/typecheck clean.

## Final packaging ✅
- README.md: architecture, run/test instructions, settings table, provider + key handling, demo script, packaging note.
- CI (GitHub Actions): install → build → lint → typecheck → vitest; bundle uploaded as artifact.
- .vscode/launch.json (F5 "Run code_modules Extension" on examples/demo, vitest task) + tasks.json.
- examples/demo: small auth/api/ui sample workspace for manual verification.
- eslint: 0 errors, 0 warnings across all packages; tsc clean.
