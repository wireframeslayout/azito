# misao runtime (experimental)

misao (操) is a headless pane server for AI coding agents. Instead of tmux, it can host the
windows and panes of a local server. This is an **experimental feature** and is available only
with `AZITO_EXPERIMENTAL_MISAO=1`. On a hub without the flag, the API, the UI, and all behavior
are unchanged.

It applies to **local servers only** (it cannot be selected for agent / SSH servers).

## Enabling it

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

### 2. Start the hub with the flag

Add `AZITO_EXPERIMENTAL_MISAO=1` to the hub's environment and restart it.

| How you run it | Where to set it |
|---|---|
| Source checkout (`npm run dev`) | `packages/server/.env` |
| Release build (systemd / launchd) | `~/.azito/hub/.env` |

```bash
echo 'AZITO_EXPERIMENTAL_MISAO=1' >> packages/server/.env
```

The hub connects to `~/.misao/misao.sock` by default. To use a daemon on another socket, set
`MISAO_SOCKET=<absolute socket path>` in **the hub's environment** (the socket path must be at most 107 bytes).
The hub and the `misao` command must see the same socket.

### 3. Switch in the server settings

1. Open the `local` server from Servers and press Edit on the Overview.
2. In "tmux runtime" choose **misao (experimental)** and save.
3. When the Overview shows `misao (experimental)` under "mux runtime" with a "Connected" chip, you are done.

Windows that already exist in tmux are not migrated to misao; windows you create afterwards are
misao panes. To go back, choose system or managed in the same dialog.

## When it cannot connect

If the Overview shows "Cannot connect to misao. You can check it from a terminal with misao status.",
the hub cannot reach the daemon.

- Run `misao status` to check that the daemon is running.
- Check that `MISAO_SOCKET` in the hub's environment (or `~/.misao/misao.sock` when unset) is the daemon's socket.
- The hub reconnects automatically when the daemon comes back.

If it shows "This runtime is only available with AZITO_EXPERIMENTAL_MISAO=1", you opened a misao
server on a hub where the flag is off. Enable the flag, or switch the runtime back to system or
managed from Edit.

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
  tui-supervisor is not used. A misao `idle` is not treated as evidence of completion, so a
  finished row ("完了 ·") appears when the agent's process exits. See "misao windows" in the
  [activity detection reference](./activity-detection.md) for details.
- tmux-specific operations such as pane zoom, saving and applying layouts, and setting pane titles are not supported.
- Restarting the daemon loses the pane processes (only metadata remains, shown as `stopped`).
- misao on agent / SSH servers, choosing it in the Add Server dialog, and the managed tmux install flow are out of scope.
