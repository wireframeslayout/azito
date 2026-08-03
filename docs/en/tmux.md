# tmux Configuration Guide

AZITO runs on top of tmux, and a few tmux settings are prerequisites for correct operation.
This guide separates them into required settings, recommended settings, and things you do
NOT need to configure (AZITO sets them at runtime).

If the server's tmux runtime is **managed** (AZITO-managed tmux under `~/.azito/tmux/`),
an `azito.conf` containing all required and recommended settings is deployed automatically —
no manual work is needed. For **system** tmux, the "Apply recommended config" button in the
Server Detail Panel idempotently appends a `source-file` line to `~/.tmux.conf`
(your existing configuration is never modified).

## Required (AZITO does not work without these)

```tmux
set -g base-index 1
set -g pane-base-index 1
```

- **`pane-base-index 1`**: AZITO addresses panes as `<session>:<window>.1`
  (agent launch via send-keys, pipe-pane, respawn, etc.). tmux's default pane index
  starts at 0, so without this setting agent launches fail with `can't find pane: 1`.
- **`base-index 1`**: windows are referenced by name, so there is no direct dependency,
  but keep it aligned with pane-base-index (both are included in `azito.conf`).

> Note: Issue #357 tracks migrating pane references to index-independent pane IDs.
> Once that lands these settings become merely recommended; until then they are required.

## Recommended

```tmux
set -s escape-time 10
set -g focus-events on
set -g history-limit 50000
set -g mouse on
```

- **`escape-time 10`**: shortens the Esc key wait (default 500ms); noticeably improves
  key responsiveness of TUI agents such as Claude Code.
- **`focus-events on`**: forwards terminal focus events to applications
  (used by Claude Code and vim).
- **`history-limit 50000`**: scrollback size. Keeps task output tracking and pane
  content retrieval from losing lines on long outputs (default 2000).
- **`mouse on`**: recommended so that wheel/touch scrolling in the browser terminal
  works as tmux scrolling.

## Not needed (AZITO configures these at runtime)

You do not need any of the following in `.tmux.conf`; AZITO sets them programmatically:

- **tmux hooks** (`set-hook -g` for window/session change detection)
- **`status off` on linked sessions** (per-browser-tab sessions for independent window selection)
- **`window-status-format`** (task window display format)
- **pipe-pane** (task output streaming)

## Settings that can interfere

- **`allow-rename`**: keep the default (off). AZITO references windows by name
  (unique labels like `win--xxxx`); if programs rename windows via escape sequences,
  those references break.
- **`renumber-windows`**: safe to enable (windows are referenced by name, not index).
- **Prefix key, keybindings, status line styling, plugins (TPM etc.)**:
  no impact on AZITO; configure freely.

## How settings are applied per mode

| Mode | How to apply |
|---|---|
| managed | Nothing to do (`~/.azito/tmux/azito.conf` is deployed automatically and loaded via `-f`) |
| system | Server Detail Panel → Dependencies → tmux row → "Apply recommended config" (idempotently appends a source-file line to `~/.tmux.conf`), or add the snippets above manually |

After changing settings, restart the tmux server (`tmux kill-server`) or run
`tmux source-file ~/.tmux.conf` in an existing session. Note that `base-index` /
`pane-base-index` do **not** retroactively apply to existing windows/panes — a tmux
server restart is the reliable way to apply them.
