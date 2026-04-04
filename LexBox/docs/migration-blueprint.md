# LexBox Migration Blueprint

## Objective

Build a Rust-driven desktop clone of the existing `desktop/` app while keeping
the renderer as close as possible to the current React codebase.

## Chosen strategy

1. Keep the existing React renderer alive with minimal changes.
2. Replace the Electron preload contract with a Tauri-compatible
   `window.ipcRenderer` bridge.
3. Route all renderer requests through a single Rust command dispatcher:
   `ipc_invoke(channel, payload)` and `ipc_send(channel, payload)`.
4. Migrate Electron handlers in slices instead of rewriting the app as a
   monolith.

## Current multi-agent workstreams

### Agent A: renderer parity

- Reuse `../desktop/src` directly from `LexBox`.
- Preserve view structure and navigation from the current app shell.
- Keep Tailwind and page-level dependencies aligned with the Electron app.

### Agent B: host compatibility

- Recreate the preload API shape in `src/bridge/ipcRenderer.ts`.
- Keep event names and channel names stable so the renderer does not need a
  cross-cutting rewrite.
- Add safe fallback responses for channels not migrated yet.

### Agent C: Rust command migration

Phase 1:

- `db:*`
- `spaces:*`
- `app:*`
- `clipboard:*`
- `manuscripts:*`
- `wechat-official:*`

Phase 2:

- `chat:*`
- `knowledge:*`
- `indexing:*`
- `media:*`
- `cover:*`
- `subjects:*`

Phase 3:

- `skills:*`
- `mcp:*`
- `assistant:*`
- `redclaw:*`
- long-running task orchestration

### Agent D: long-cycle orchestration

- Track IPC parity, page parity, and backend parity as separate lanes.
- Keep Node-heavy AI runtimes available as sidecars while Rust host capability expands.
- Use the generic router to migrate entire namespaces in batches instead of one-off handlers.

## Practical constraint

The current machine does not have Cargo installed, so the Rust side is
scaffolded but not compiled in this turn. Frontend reuse and router structure
have been prepared so that work can continue immediately after Rust tooling is
installed.
