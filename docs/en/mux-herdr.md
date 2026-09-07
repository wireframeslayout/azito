# herdr Driver (PoC)

Guide for using herdr v0.8.2 as an AZITO mux driver.

## Prerequisites

- herdr v0.8.2 (Rust-based, agent-aware terminal multiplexer, herdrdev/herdr)
- No root access required (user-space install)
- Official docs: https://herdr.dev/docs/
- API schema: `docs/ja/mux-herdr.schema.json` (protocol 20, schema_version 1)

## Install

```bash
bash harness/mux/herdr/install.sh
# → Installs to ~/.local/bin/herdr (sha256-verified)
```

## Start

```bash
bash harness/mux/herdr/start.sh
# Runs HERDR_SESSION=azito herdr server in headless mode
# Uses systemd user unit if available, otherwise nohup
```

Socket: `~/.config/herdr/sessions/azito/herdr.sock`

Config (`harness/mux/herdr/azito.toml`) disables: sidebar, tab bar (single tab), pane borders/gaps/scrollbars, mouse capture, close confirmation. `start.sh` deploys this to `~/.config/herdr/config.toml` and reloads an already-running server via `server.reload_config` RPC.

## MuxRef format

```json
{"kind":"herdr","workspace":"<workspace label>","window":"main"}
```

- `workspace`: herdr workspace label = AZITO window name
- `window`: fixed value `"main"` (not used for display)

### Mapping rules

AZITO window = herdr workspace. Each workspace uses only the first tab; additional tabs are ignored (a diagnostic warning is logged).

| AZITO concept | herdr concept |
|---|---|
| Container (session) | herdr session (fixed: `azito`) |
| Window | herdr workspace |
| Pane | Panes in the first tab of a workspace |

- `openWindow()` calls `workspace.create` (not `tab.create`)
- `closeWindow()` calls `workspace.close`
- `renameWindowByRef()` calls `workspace.rename`
- `windowExists()` checks workspace label existence only (`ref.window` is ignored)

### Legacy ref fallback

Legacy refs like `{"kind":"herdr","workspace":"azito","window":"win--abc"}` (where `window` is an actual tab label) are supported via fallback in `resolvePane` / `listPanesByRef` when the workspace label doesn't match. No migration is added.

## Agent-side attach

When `AZITO_MUX_RUNTIME=herdr`, the agent process creates a `HerdrSocketClient` from `HERDR_SESSION` (default `azito`). On terminal attach (`/ws?ref=<herdr ref>&pane=1`), the agent focuses the target tab/pane via the socket before spawning `herdr` (the TUI client). `start.sh` must have deployed `azito.toml` to suppress mouse capture (`?1000h`).

## Registering with AZITO

Select `herdr` as `mux_runtime` when adding a server. Register with a distinct name (e.g., `server007-herdr`).

## Protocol characteristics

- **One connection per request**: Server closes the connection after sending one response line. Only `events.subscribe` keeps the connection open for streaming.
- ID format: workspace `w1`, tab `w1:t1`, pane `w1:p1`
- `workspace.create` / `tab.create` `name` param does not set the `label` — call `workspace.rename` / `tab.rename` immediately after creation.

## Capabilities (caps)

| Capability | Supported | herdr API | Notes |
|------------|-----------|-----------|-------|
| outputStream | **No** | — | No pipe-pane equivalent. Task execution returns 409. |
| changeEvents | Yes | `events.subscribe` | Built-in events |
| agentState | Yes | `pane.agent_status_changed` | Mux-native agent state |
| independentClients | Yes | — | Pending verification |
| envInjection | Yes | `workspace.create` / `tab.create` / `pane.split` `env` param | |
| zoom | Yes | `pane.zoom` | |
| copyMode | No | — | |
| paneTitle | Yes | `pane.rename` | |
| activityCounter | No | — | No `window_activity` equivalent |
| layoutSnapshot | Yes | `layout.export` / `layout.apply` | |

## Known limitations

- **No task execution**: `outputStream=false` prevents `AZITO_DONE_*` marker detection. Returns 409 `mux_capability_missing`.
- **Empty pane.read**: When no client is attached, `pane.read` may return empty `text` with `revision` 0 (PTY size undetermined).
- **Activity detection**: Shown in diagnostics panel as `decidedBy: 'tier0_mux'` only. Not integrated into the detection tier priority.

## Verification results

> Results from `scripts/poc/herdr-verify.ts`.

### 1. Independent client focus
_Not yet run_

### 2. Environment injection
_Not yet run_

### 3. pane.send_text size limits
_Not yet run_

### 4. Output stream alternative (pane.read polling + pane.wait_for_output)
_Not yet run_ — Also check empty text issue when no client is attached.

### 5. Tab bar visibility
_Not yet run_
