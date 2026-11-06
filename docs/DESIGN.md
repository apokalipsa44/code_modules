# code_modules — design note

Revenue-pitch: turn a codebase into an editable node graph with hard locks the AI agent cannot bypass.

## Repo layout (npm workspaces monorepo)

```
packages/
  core/       pure TS library, zero `vscode` imports
    src/
      model.ts        # Node, Edge, GraphIndex, Contract types (schemaVersion 1)
      hashing.ts      # sha256 content/meta hashes
      extract/        # tree-sitter (web-tree-sister + prebuilt wasms) TS/JS extractor
      graph/          # store (.nodes/index.json load/save/migrate), layout helpers
      locks/          # lock engine: policies, canEdit decisions, contract generation
      meta/           # metadata store, staleness, bottom-up scan ordering
      agent/          # ModelProvider interface, tool implementations, runner, rollback guard
      edit/           # EditApplier interface (core-side); extension implements with WorkspaceEdit
  extension/  VS Code host (esbuild bundle)
      extension.ts    # activate/deactivate, command wiring
      graphView.ts    # webview host + typed postMessage
      lspBridge.ts    # references/definitions for edges
      watcher.ts      # save/FS watchers, incremental re-extract, lock tamper detection
      editApplier.ts  # WorkspaceEdit implementation
      agent/claudeProvider.ts  # Claude Agent SDK adapter (behind ModelProvider)
      agent/mockProvider.ts    # offline mock for tests/dev
  webview/    React + Vite + @xyflow/react + monaco-editor
      src/app.tsx     # graph canvas
      src/protocol.ts # ALSO mirrored in core as messageProtocol.ts (single source of truth: packages/core/src/protocol.ts)
```

Single source of truth for the webview<->extension message protocol lives in **core** (`code_modules/core/protocol.ts`); the webview imports it (type-only) so there is no drift.

## Message protocol (typed postMessage)

`FromExtensionToWebview` (one-way state pushes):
- `graphUpdated { nodes: GraphNode[], edges: Edge[], layers: string[] }`
- `nodeContent { id, file, range, content }` — sent on demand for edit mode
- `nodeDiff { id, old, new }` — proposed agent edit preview
- `agentProgress { nodeId?, message, kind }`
- `metadataUpdated { ids }`
- `error { message }`

`FromWebviewToExtension` (intents):
- `ready {}` — extension replies with `graphUpdated`
- `search { query, depth, layerFilter }`
- `revealNode { id }` (open in editor), `expandNode { id, depth }`
- `startEdit { id }`, `saveEdit { id, content }`, `cancelEdit { id }`
- `toggleLock { id }`
- `refresh { full }`
- `agentRun { rootIds, instruction }`
- `setSettings { patch }`

Discriminated unions on `type`; the webview contains **no business logic** — it renders state and sends intents only.

## Persistence

`.nodes/index.json` versioned with `schemaVersion: 1`. Loader migrates older versions forward (currently a no-op migration table keyed by version). Content-addressed node ids (`file#symbolPath`) survive line shifts; rename/move re-link via `relinkByHash()` when content hash match exists under a stale id.

## Agent & locks

- `ModelProvider` (core interface): `complete(req): AsyncIterable<AgentEvent>` — Claude Agent SDK adapter implements it; offline `MockProvider` used in tests.
- Agent only ever receives tools implemented against `core`'s tool layer: `search_nodes`, `read_node`, `edit_node`, `create_node`, `list_dependencies`, `list_dependents`, `run_checks`. No raw FS/bash tools exist.
- Enforcement is 3 layers: (1) tools never expose raw writes, (2) every handler re-checks `Locks.canEdit`, (3) `permissionGate` (`canUseTool` equivalent) is the final pass and rejects anything unexpected.
- Indirect breakage guard: after `edit_node`, dependents are re-analyzed; if a locked dependent's contract (signature/type) breaks → rollback (restore original content via `EditApplier`) + return diagnostics.
