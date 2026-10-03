# misao runtime

misao (操) is a headless pane server for AI coding agents. Instead of tmux, it can host the
windows and panes of a local server. The hub always registers the misao driver and each server picks its
"default terminal" (misao or tmux). The hub starts even when no daemon is running; that server is then
reported as unable to connect.

It applies to **local servers only** (it cannot be selected for agent / SSH servers).

## Getting started

### 1. Install and start misao

misao lives in its own repository ([wireframeslayout/misao](https://github.com/wireframeslayout/misao)).
It requires Node.js 24 or later. Build it, put `misao` on your PATH, and start the daemon.

```bash
git clone https://github.com/wireframeslayout/misao.git
cd misao
npm ci && npm run build
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/dist/main.js" ~/.local/bin/misao
misao serve            # runs in the foreground; use a systemd user unit to keep it running
```

To keep it running (`systemctl --user enable --now misao.service`), see misao's
[deploy/README.md](https://github.com/wireframeslayout/misao/blob/main/deploy/README.md).
You can check that it is up from a terminal:

```bash
misao status
```

### 2. Check where the hub connects

The hub connects to `~/.misao/misao.sock` by default. To use a daemon on another socket, set
`MISAO_SOCKET=<absolute socket path>` in **the hub's environment** (the socket path must be at most 107 bytes).
The hub and the `misao` command must see the same socket. Set it in `packages/server/.env` for a source checkout
(`npm run dev`), or in `~/.azito/hub/.env` for a release build (systemd / launchd).

### 3. Switch in the server settings

1. Open the `local` server from Servers and press Edit on the Overview.
2. In "Default terminal" choose **misao** and save ("tmux executable" is the setting for when you use tmux: System or Managed).
3. When the Overview shows `misao` under "Default terminal" with a "Connected" chip, you are done.

Windows that already exist in tmux are not migrated to misao; windows you create afterwards are
misao panes. To go back, choose tmux under "Default terminal" in the same dialog.

The API takes `defaultMux` (`"misao"` / `"tmux"`; misao is local servers only) and `muxRuntime`
(`"system"` / `"managed"`, the tmux executable) separately on `PUT /api/servers/:name`.
The former `muxRuntime: "misao"` is still accepted as `defaultMux: "misao"` for compatibility, and will be removed in the next release.

## When it cannot connect

If the Overview shows "Cannot connect to misao. You can check it from a terminal with misao status.",
the hub cannot reach the daemon.

- Run `misao status` to check that the daemon is running.
- Check that `MISAO_SOCKET` in the hub's environment (or `~/.misao/misao.sock` when unset) is the daemon's socket.
- The hub reconnects automatically when the daemon comes back.

## Stopped panes and empty windows

- After the daemon restarts, existing panes are restored as `stopped` (no process). In the server's window list
  such a pane is dimmed and carries a "Stopped" chip; a pane whose process merely ended carries an "Exited" chip.
  tmux panes, whose driver does not report a process state, get neither.
- Opening a window attaches to a live pane (the first `running` one), or to the first pane when none is running.
- A `stopped` pane cannot be attached. When you open one explicitly the terminal WebSocket closes with code **4410**
  (reason `pane stopped`) and does not reconnect; the screen says the pane is stopped and offers "Delete pane".
  The delete button on the pane's row in the list does the same (`DELETE .../panes/:ordinal`, the daemon's `pane.close`).
  An `exited` pane is still attachable, as before (you see its last screen).
- Closing the last pane does not remove the window: it stays as an "empty window" with no panes. The list shows
  "No panes" with "Open a pane" and "Delete window". Connecting to an empty window closes the WebSocket with code **4412**
  (reason `window empty`) and the screen shows the same choices. "Open a pane" lets you pick the launch command (shell only /
  an agent / custom): it calls `POST /api/servers/:name/mux/windows/:ref/panes/open` (body `{ "command"?: string }`), which opens a shell
  pane and then types the command into it.
- A window that does not exist still closes with code **4404** (`window not found`), handled separately from the two above.
- A misao window's label is the window name alone (tmux keeps `session:window`).

## What works, and limits

- Browser terminal attach, creating and operating windows and panes, task execution (the agent
  runs in a window on the worktree), and activity detection are supported.
- Activity detection uses the daemon's `pane.state` events (`tier0_mux` in `GET /api/debug/activity`);
  tui-supervisor is not used. A misao `idle` alone is not treated as evidence of completion, but when Claude's
  Stop hook has arrived the finished row ("完了 ·") appears (`refinedBy: tier1_hook_stop`); for agents without hooks
  (codex etc.) it appears only when the process exits. See "misao windows" in the
  [activity detection reference](./activity-detection.md) for details.
- tmux-specific operations such as pane zoom, saving and applying layouts, and setting pane titles are not supported.
- Restarting the daemon loses the pane processes (only metadata remains, shown as `stopped`).
- misao on agent / SSH servers, choosing it in the Add Server dialog, and the managed tmux install flow are out of scope. Choosing misao or tmux per window is future work.
