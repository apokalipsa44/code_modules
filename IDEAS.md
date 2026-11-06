# IDEAS

- `mcp-server` package: expose `core` (graph + tools) as an MCP server with a `PreToolUse` hook that blocks raw Edit/Write on locked ranges → lets Claude Code users share the same lock truth.
- Layer swimlanes: place nodes into collapsible clusters grouped by tag (`auth`, `ui`, …) in the canvas.
- Diff review UX: true three-way diff preview per agent edit in a diff webview instead of a text-only approval payload.
- Node grouping by file when > N nodes from the same file are visible.
- Hash-similarity rename heuristic beyond exact-hash tombstones (e.g. ≥0.9 Levenshtein on symbol bodies).
- Persist LSP-edge provenance (`type: 'lsp'`) to reconcile fallback edges automatically once the server warms up.
- Multi-root workspace support (one `.nodes/index.json` per root).
- Telemetry opt-in with privacy-preserving aggregate node counts (still off by default).
- Webview snapshot export (SVG/PNG) for docs.
