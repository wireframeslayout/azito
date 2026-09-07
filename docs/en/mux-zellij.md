# zellij Driver (PoC)

Guide for using zellij v0.45.1 as an AZITO mux driver.

## Prerequisites

- zellij v0.45.1 (Rust-based terminal multiplexer, zellij-org/zellij)
- No root access required (user-space install)
- Official docs: https://zellij.dev/documentation/
- External control via `zellij action` CLI. Event notifications require a custom WASM plugin (this PoC uses polling fallback)

## Install

```bash
bash harness/mux/zellij/install.sh
# → Installs to ~/.local/bin/zellij (sha256-verified, musl static build)
```

## Configuration

```bash
mkdir -p ~/.config/zellij/layouts
cp harness/mux/zellij/config.kdl ~/.config/zellij/config.kdl
cp harness/mux/zellij/azito-layout.kdl ~/.config/zellij/layouts/azito.kdl
```

Key `config.kdl` settings:

| Setting | Value | Purpose |
|---------|-------|---------|
| `simplified_ui` | `true` | Minimize UI elements |
| `pane_frames` | `false` | Hide pane borders |
| `mirror_session` | `false` | Independent tab selection per client |
| `default_layout` | `"azito"` | Layout without tab-bar / status-bar |
| `mouse_mode` | `false` | Disable mouse for terminal pass-through |

`azito-layout.kdl` defines a minimal layout without tab-bar or status-bar.

## Session startup

```bash
zellij --session azito --new-session
# Starts in background (no client attached)
# If session exists, attaches to it
```

zellij has no daemon mode. The server process starts on first client attach and persists after all clients disconnect.

## MuxRef format

```json
{"kind":"zellij","workspace":"<session name>","window":"<tab name>"}
```

- `workspace`: zellij session name (e.g. `"azito"`)
- `window`: zellij tab name (e.g. `"win--abc"`)

## Headless limitations

In headless sessions (no client attached), `new-tab` creates an empty tab with zero terminal panes (even with `--layout-string`). `openWindow` uses `--layout-string 'layout { pane; }'` as best-effort, but panes may only materialize when a client is attached. Tabs without panes:

- Are invisible to `list-panes --all --json`
- Can appear in `query-tab-names` but with unreliable tab_id correlation
- Cannot be operated on (capture, send-keys, split) until a pane exists

The `resolveTabId` fallback uses `query-tab-names` index as tab_id (works for fresh sessions where position == id). For production use with headless tab creation, a persistent attached client (e.g. `zellij attach` via node-pty) would be needed.

## Registering with AZITO

Select `zellij` as `mux_runtime` when adding a server. Register with a distinct name (e.g., `server007-zellij`).

## Capabilities (caps)

| Capability | Supported | zellij CLI | Notes |
|------------|-----------|-----------|-------|
| outputStream | **No** | -- | No pipe-pane equivalent. Task execution returns 409. |
| changeEvents | **No** | -- | No event notification. 5s polling fallback. |
| agentState | **No** | -- | No agent detection (Tier 2 screen classification works via `captureScreen`) |
| independentClients | Yes | `mirror_session false` | Independent tab focus per client |
| envInjection | Yes | `new-pane -- env KEY=VAL cmd` | |
| zoom | Yes | `toggle-fullscreen --pane-id` | Toggle fullscreen by pane ID |
| copyMode | **No** | -- | |
| paneTitle | Yes | `rename-pane --pane-id` | |
| activityCounter | **No** | -- | No `window_activity` equivalent |
| layoutSnapshot | Yes | `dump-layout` | KDL format layout output |
| stablePaneHandle | Yes | `list-panes --all --json` | Stable `terminal_N`/`plugin_N` IDs |

## Known limitations

- **No task execution**: `outputStream=false` prevents `AZITO_DONE_*` marker streaming. Returns 409 `mux_capability_missing`.
- **Event delay**: Session/tab change detection up to 5s (polling interval). Slower than tmux hooks (<1s) and herdr events (<100ms).
- **Activity detection**: `agentState=false`. No Tier 0 driver-direct detection. Tier 2 screen classification via `captureScreen` works as fallback.

## Plugin assessment

### (a) Polling fallback latency

Session/tab change detection uses 5s polling interval. Noticeable lag in UI sidebar updates. A WASM plugin subscribing to `TabUpdate` / `PaneUpdate` events would provide instant notification.

### (b) Focus-dependent operations

In 0.45.1, these commands accept `--pane-id` / `--tab-id`, largely eliminating focus dependency:

- `write-chars --pane-id` / `write --pane-id` -- text/byte input
- `dump-screen --pane-id` -- screen capture
- `close-pane --pane-id` / `close-tab --tab-id` -- close
- `rename-tab --tab-id` / `rename-pane --pane-id` -- rename
- `new-pane --tab-id --no-focus` -- pane creation

Only `go-to-tab-name` remains focus-dependent, used only for initial tab selection on terminal attach. Minimal impact on parallel tasks.

### (c) WASM plugin estimate

Implemented in Rust using the `zellij-tile` crate. Minimal scope (event notification + pane_id export): 200-400 lines Rust. Build with `cargo build --target wasm32-wasi`.

Since 0.45.1's `list-panes --all --json` provides stable pane IDs (`terminal_N`/`plugin_N`) via CLI, a plugin is not needed for the PoC.

### Conclusion

The 0.45.1 CLI expansions (vs. the 0.39-era assumptions) enable significantly more functionality without a plugin. A plugin would only be needed for:

1. **Real-time event notification** (`changeEvents`) -- instant sidebar updates
2. **Agent activity detection** (`agentState`) -- Tier 0 detection

A plugin is not needed for the PoC scope. For production adoption, a plugin would be beneficial for event notification.

## CLI reference (0.45.1, tested)

### Sessions

```bash
zellij list-sessions --no-formatting
# Output: azito [Created 5s ago]
#         old-session [EXITED]

zellij kill-session <session>
zellij delete-session --force <session>
```

### Tabs

```bash
zellij --session <s> action query-tab-names
# Output: one tab name per line

zellij --session <s> action new-tab --name <n> --cwd <d>
# Output: created tab's tab_id (number)

zellij --session <s> action close-tab --tab-id <t>
zellij --session <s> action rename-tab --tab-id <t> <name>
zellij --session <s> action go-to-tab-name <name>
```

### Panes

```bash
zellij --session <s> action list-panes --all --json
# Output: JSON array. Each element has id, is_plugin, tab_id, tab_name,
#         pane_command, pane_cwd, is_focused, is_floating, etc.

zellij --session <s> action new-pane --direction <down|right> --tab-id <t> --no-focus
# Output: created pane's pane_id (e.g., terminal_4)

zellij --session <s> action write-chars --pane-id <p> <text>
zellij --session <s> action write --pane-id <p> <bytes...>
zellij --session <s> action dump-screen --pane-id <p>
zellij --session <s> action close-pane --pane-id <p>
zellij --session <s> action rename-pane --pane-id <p> <name>
zellij --session <s> action focus-pane-id <p>
```
