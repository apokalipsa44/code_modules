# NodeCode

A VS Code extension that turns a codebase into an **editable node graph**, with
**agent-enforced per-node locks**: an AI agent can explore, edit and create nodes,
but whatever you lock — it cannot touch, not even indirectly.

```
┌────────────────────────────────────────────────────────────────┐
│  webview (React Flow)        extension host       agent        │
│  graph + node cards  ⇄  router ⇄ GraphService ⇄ ToolGate      │
│  Monaco editor               WorkspaceEdit        LockEngine   │
└────────────────────────────────────────────────────────────────┘
```

## What it does

- **Extracts** every function, class, method, arrow component, route handler,
  config block and type of a TS/TSX/JS workspace into nodes via
  tree-sitter (WASM, runs fully in the extension host — no native binaries).
- **Renders** them as a React Flow graph (dagre auto-layout, search box with
  ranked matching, depth control, layer filter chips, minimap).
- **Edits in place**: click a node → a Monaco editor opens inside the card →
  `Ctrl/Cmd+S` applies the change through `WorkspaceEdit` (undoable, native
  dirty state) and the file is re-extracted immediately.
- **Locks**: lock any node from its card. Locks mean:
  - the node itself cannot be edited/created-over/deleted by the agent,
  - descendants of a locked node are effectively locked,
  - an ancestor replacement that would erase locked code is rejected,
  - a **breakage guard** rolls back agent edits that leave locked files
    (or their transitive dependents) with failing checks.
- **`/init` scan**: bottom-up metadata generation (summaries, tags) with a
  token budget, stale-skip resume, progress + cancellation, and proposed
  tags for the default lock policy. Everything persists to
  `.nodes/index.json` (versioned, additive schema).
- **Agent runs** through a strict tool whitelist only:
  `search_nodes, read_node, edit_node, create_node, list_dependencies,
  list_dependents, run_checks`. There is **no raw file-write or bash tool**
  anywhere in the tool surface; the SDK path additionally denies unknown
  tools via a `canUseTool` gate.

## Repository layout

| Package | Role |
|---|---|
| `packages/core` | Pure TypeScript: graph model, tree-sitter extractor, lock engine, search, `/init` scan, agent `AgentRunner` + `ToolGate`. **Never imports `vscode`.** |
| `packages/extension` | Thin VS Code host: webview CSP host, pure typed intent `router`, `WorkspaceEdit` applier, tamper guard, checks runner, SecretStorage, Claude Agent SDK adapter. |
| `packages/webview` | React + Vite + `@xyflow/react` + Monaco UI built as a static bundle, loaded by the extension host. |

## Run it

```bash
npm install          # workspaces + tooling
npm run build        # core → webview → extension (couples webview dist into ext dist)
```

Then in VS Code:

1. Open this repo (or any folder) in a shell and `code packages/extension`
   *inside* the same workspace, or just open the repo root —
   **F5** launches a preconfigured "Run NodeCode Extension" debug session
   (see `.vscode/launch.json`, builds are wired to pre-launch tasks if missing).
2. In the opened window run **NodeCode: Open Graph** from the Command Palette.
3. Optional: run **NodeCode: /init — Scan workspace and generate metadata**
   for summaries, tags and a default lock policy.

No display / headless CI: everything except the live host is exercised by
`npm test` (see [blockers](#blockers)).

## Agent provider

Two providers exist behind the same `MetaProvider`/tool-gate interfaces in core:

- **offline `mock` (default)** — deterministic, no network, no key; used by all
  tests and automatically when no API key is configured. Good enough to verify
  the full graph/edit/lock flow.
- **Claude (Agent SDK)** — implemented (MCP tool server + `canUseTool` deny
  gate). Enable it with **both**:

  1. `nodecode.modelProvider = "claude"`, and
  2. an API key stored *only* in VS Code **SecretStorage**: run
     `NodeCode: Open Graph` then any `/init`-like flow prompts to save it,
     or run the suggested command palette flow to store
     `nodecode.apiKey`. Alternatively set the `ANTHROPIC_API_KEY`
     environment variable before launching VS Code (less safe; SecretStorage
     is preferred).

  Without a key the extension falls back to the offline mock and shows a
  warning; locks are enforced identically in **any** provider.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `nodecode.depth` | `2` | dependency expansion depth when searching (1–4) |
| `nodecode.autoLayout` | `true` | dagre auto-layout |
| `nodecode.checkCommand` | `""` | read-only command run after agent edits, e.g. `npx tsc --noEmit`; part of the indirect breakage guard |
| `nodecode.reviewEdits` | `false` | agent edits land in a diff-review queue instead of auto-applying |
| `nodecode.excludedFolders` | glob list | folders skipped when scanning |
| `nodecode.maxVisibleNodes` | `400` | render cap / lazy-edge past this |
| `nodecode.initBudgetTokens` | `750000` | /init token budget |

Everything is logged, nothing is telemetred — ever.

## Demo script (manual, ~90 s)

1. `F5` → **NodeCode: Open Graph** → `NodeCode: /init`.
2. Search `getSession`, pick a depth, watch the LPC layer chips.
3. **Lock** `src/auth.ts#getSession` from its card.
4. Open the agent dock: *“add a border to the avatar component”* →
   the avatar node edits and the graph re-extracts.
5. Ask: *“refactor getSession to take a config object”* → **denied** by the
   ToolGate (lock violation) with the reason surfaced in the webview.
6. `Ctrl/Cmd+S` on any card runs `WorkspaceEdit` — undo it straight from
   VS Code's undo stack.

A throwaway workspace with an `auth`/`api`/`ui` split lives in
`examples/demo` for exactly this.

## Tests

```bash
npm test             # vitest, 37 tests / 8 files
npm run lint
npm run typecheck
```

Coverage matrix: extractor (fixtures incl. nested fns, default exports,
decorators), store (IDs, tombstones, staleness), locks (self/descendant/ancestor
rules), agent ToolGate (lock bypass attempts, breakage-guard rollback),
scan (bottom-up, fresh-skip, budget), search ranking, protocol/router
round-trip.

## Blockers

Two things could not be executed in the build sandbox — see
[`BLOCKERS.md`](BLOCKERS.md):

1. `@vscode/test-electron` F5-style integration run (no X display / no xvfb).
   Router+protocol tests cover the round-trip instead.
2. Live Claude SDK E2E (no API key). The SDK path is implemented offline-safe;
   with a key it runs unchanged.

## Decisions

Architecture, lock semantics, model protocol and other judgment calls are
chronicled in [`DECISIONS.md`](DECISIONS.md); nice-to-haves in
[`IDEAS.md`](IDEAS.md), phase-by-phase build log in [`PROGRESS.md`](PROGRESS.md).

## Packaging note

Not published per spec (YOLO rules forbid external accounts/services). To make
a local `.vsix` manually:

```bash
npx --yes @vscode/vsce package --no-dependencies -o dist/nodecode.vsix
```

(`vsce` needs a display-less environment only for `npm test`; packaging is
headless-safe.)
