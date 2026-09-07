# herdr Driver (PoC)

Setup guide and constraints for using herdr v0.8.2 as an AZITO mux driver.

## Prerequisites

- herdr v0.8.2 (Rust-based, agent-aware terminal multiplexer)
- No root access required (user-space install)
- Official docs: https://herdr.dev/docs/

## Installation

```bash
# Use the bundled install script
bash harness/mux/herdr/install.sh
# → Installs to ~/.local/bin/herdr (with sha256 verification)
```

## Starting

```bash
# Start herdr server in headless mode
bash harness/mux/herdr/start.sh
# Uses systemd --user unit if available, otherwise nohup
```

The config file (`harness/mux/herdr/azito.toml`) automatically disables:
- Sidebar (hidden)
- Tab bar (hidden when single tab)
- Pane borders, gaps, and scrollbars
- Mouse capture
- Close confirmation dialogs

## Registering in AZITO

Select `herdr` as `mux_runtime` when adding a server.

- Register under a separate name from any existing tmux server (e.g. `server007-herdr`)
- The herdr server must be running

## Capabilities

| Capability | Supported | Notes |
|------------|-----------|-------|
| outputStream | **No** | No pipe-pane equivalent. Task execution unavailable |
| changeEvents | Yes | Built-in events via `events.subscribe` |
| agentState | Yes | `pane.agent_status_changed` provides agent activity state |
| independentClients | Yes | Multiple clients with independent focus |
| envInjection | Yes | `env` parameter on `workspace.create`/`tab.create`/`pane.split` |
| zoom | No | |
| copyMode | No | |
| paneTitle | No | |
| activityCounter | No | No `window_activity` equivalent |
| layoutSnapshot | No | |

## Known Limitations

- **No task execution**: `outputStream=false` means the `AZITO_DONE_*` marker detection via pane output streaming is unavailable. Attempting task execution returns 409 `mux_capability_missing`
- **pane.read polling**: Polling `pane.read` as an output stream alternative is under investigation (verification item 4)
- **Activity detection**: Shown in the diagnostics panel (`GET /api/debug/activity`) as `decidedBy: 'tier0_mux'`, but not yet integrated into the priority ladder (pending post-#155 merge)

## Verification Results

> Results from `scripts/poc/herdr-verify.ts` to be transcribed below.

### 1. Independent Client Focus

_Not yet run_

### 2. Env Injection

_Not yet run_

### 3. pane.send_text Size Limit

_Not yet run_

### 4. Output Stream Alternative

_Not yet run_

### 5. Tab Bar Visibility

_Not yet run_
