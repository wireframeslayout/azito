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

## Client Configuration and Navigation Lock

### Overview

AZITO generates two herdr client configuration files and applies a dedicated configuration to terminals opened through AZITO.

- `~/.azito/herdr/client-locked.toml` — disables workspace/tab navigation keybindings
- `~/.azito/herdr/client-free.toml` — recommended UI settings only (no keybinding restrictions)

### Lock Scope

**The lock only affects clients opened through AZITO.** Clients opened directly on the server via the `herdr` command are not affected. AZITO specifies the client configuration file via the `HERDR_CONFIG_PATH` environment variable when opening a terminal, so regular herdr clients without that variable use the server's default configuration (`~/.config/herdr/config.toml`).

### Resolution Order

1. Window's `herdrNavigationLock` (`'locked'` / `'free'` / `null`)
2. Server's `herdrNavigationLock` (`'locked'` / `'free'`, default `'locked'`)

When the window value is `null` (follow server default), the server's value is used.

### UI Recommended Value Diagnostics

Settings → Servers checks the server's `~/.config/herdr/config.toml` and shows warnings when the following recommended values differ (no auto-correction):

| Key | Recommended |
|-----|-------------|
| `hide_tab_bar_when_single_tab` | `true` |
| `sidebar_collapsed_mode` | `"hidden"` |
| `mouse_capture` | `true` |

## Focus Sync

When the user switches workspaces in a herdr client, the AZITO Web UI can bring the corresponding window (or task tab) to the foreground.

### Event flow (herdr → Web UI)

```
herdr socket → workspace.focused event
  → agent (relays as mux-event to hub, adds workspace_label)
  → hub HerdrEventBridge
    → mux_ref reverse lookup (windowRepo.findByServerAndRef)
    → NotificationBus.emit('mux:focus', { serverName, windowId, taskId?, source })
  → events WS → frontend
    → useFocusSync → selectTaskTerminal / openTask / connectPane
```

- The agent's herdr subscription includes `workspace.focused`. It resolves `workspace_id` → `workspace_label` and relays.
- Hub side: `HerdrEventBridge` uses `herdrMuxRef(label)` to look up the DB `windows.mux_ref` column and find `windowId` / `taskId`.
- Unregistered windows (no matching mux_ref) are ignored.

### Follow toggle

The Objects sidebar has a "Follow herdr" toggle (`localStorage` key: `follow-herdr`, default OFF). When ON, `mux:focus` events bring the corresponding window to the foreground.

### Reverse direction (Web UI → herdr)

`POST /api/windows/:id/focus` issues the herdr `workspace.focus` RPC (or tmux `select-window`). The Web UI calls this when the user clicks a window row in the sidebar.

`localStorage` key: `focus-sync-reverse` (default ON) controls this.

### Loop prevention

When the hub issues a `workspace.focus` RPC, it ignores any `workspace.focused` event for the same workspace arriving within 2 seconds. This prevents a Web UI → herdr → Web UI echo loop.

### Multiple clients

herdr 0.9 supports independent per-client display. If `workspace.focused` events do not carry a `client_id`, the event is treated as the server's active focus (no per-client distinction).
