# misao runtime

misao (操) is a headless pane server for AI coding agents. Instead of tmux, it can host the
windows and panes of a local server. The hub always registers the misao driver and each server picks its
"default terminal" (misao or tmux). The hub starts even when no daemon is running; that server is then
reported as unable to connect.

It applies to local servers and to agent servers (see [Agent servers](#agent-servers)); it cannot be selected for SSH servers.

## Getting started

### Release builds (install.sh)

Release builds **bundle** misao. `install.sh` sets it up and starts it as the `azito-misao` service (systemd / launchd) and writes
`MISAO_SOCKET` to the hub's `.env`, so there is nothing to prepare by hand. tmux is optional (you can use AZITO without it).
On a fresh install the local server's default terminal is misao.

- Check its state with `azito misao status`, or on the misao row under Servers → your server → Setup.
- **Existing installs** (set up before misao was bundled): install it with `azito misao install`, or "Install misao" on the Setup row.
  It edits `.env`, so restart the hub afterwards (panes are not affected).
- **Updates**: updating the hub neither updates nor restarts misao (restarting it would end every pane). When the running version differs
  from the bundled one, the Setup row says so. You switch explicitly with `azito misao update`, or "Update misao (running panes will end)".
  An install of 0.2.0 (the Node build) moves to 0.3.0 (the native binary) the same way: the unit is regenerated on update (it has no node in it any more), the old version directory is left in place, and a failed update restores the previous unit and version.
- On a host without tmux, the "Terminal" choice when adding a window disables tmux (with the reason), and the Setup tmux row is labelled "Optional".

For the service layout, commands and manual setup see [Install and update](./install-and-update.md#misao-service).

### Source checkouts (npm run dev) and self-managed daemons

A source checkout (`npm run dev`) installs no service. Prepare misao yourself as below and connect through `MISAO_SOCKET` (or the default socket).
A release build uses the same setting when you want it to talk to another daemon.

### 1. Install and start misao

misao lives in its own repository ([wireframeslayout/misao](https://github.com/wireframeslayout/misao)).
It is a single native binary (no Node.js needed). Download the archive for your OS / architecture from the
[Releases](https://github.com/wireframeslayout/misao/releases) page (`misao-<version>-<target>.tar.gz`, targets
`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`, `x86_64-apple-darwin`), put `misao` on your PATH, and start the daemon.

```bash
tar xzf misao-0.3.0-x86_64-unknown-linux-musl.tar.gz
mkdir -p ~/.local/bin && install -m 755 misao-0.3.0-x86_64-unknown-linux-musl/misao ~/.local/bin/misao
misao serve            # runs in the foreground; use a systemd user unit to keep it running
```

To keep it running (`systemctl --user enable --now misao.service`), see misao's
[deploy/README.md](https://github.com/wireframeslayout/misao/blob/main/deploy/README.md).
You can check that it is up from a terminal:

```bash
misao status
```

### 2. Check where the hub connects

The hub connects to `~/.misao/misao.sock` by default (on a release build, install.sh writes `~/.azito/misao/misao.sock` to `.env`). To use a daemon on another socket, set
`MISAO_SOCKET=<absolute socket path>` in **the hub's environment** (the socket path must be at most 107 bytes).
The hub and the `misao` command must see the same socket. Set it in `packages/server/.env` for a source checkout
(`npm run dev`), or in `~/.azito/hub/.env` for a release build (systemd / launchd).

### 3. Switch in the server settings

1. Open the `local` server from Servers and press Edit on the Overview.
2. In "Default terminal" choose **misao** and save ("tmux executable" is the setting for when you use tmux: System or Managed).
3. When the Overview shows `misao` under "Default terminal" with a "Connected" chip, you are done.

"Default terminal" decides where new windows are created. A local server handles tmux and misao windows
at the same time: windows that already exist in tmux are not migrated and keep working as tmux windows
(activity detection, the terminal and task follow-ups each follow the window's own mux). To go back,
choose tmux under "Default terminal" in the same dialog.

## Using tmux and misao on one server

- Window and pane operations are routed to tmux or misao by the window's `mux_ref` kind (a pane by its handle's
  shape; misao's are `p_<ULID>`). The server's default only applies to windows created from now on.
- `GET /api/servers/:name/sessions` returns both listings merged, each session stamped with `kind`
  (`"tmux"` / `"misao"`), so same-named sessions of the two muxes are told apart.
- With `?detail=1` it returns `{ sessions, unavailable }`: `unavailable` lists the muxes the server hosts that could
  not be listed (e.g. `{ "kind": "misao", "reason": "daemon_unreachable" }`). While the daemon is down the other
  mux's sessions are still returned, and the stopped mux's windows are not treated as deleted (their tabs stay open
  and activity detection announces no completion). When neither can be listed the request fails.
- Workspace operations such as `POST /api/servers/:name/mux/workspaces` accept `kind` (default: the server's default).
- A misao window's `tmux_target` is stored as `<workspace>:<window id>` (migration 078 converts existing rows).

The API takes `defaultMux` (`"misao"` / `"tmux"`) and `muxRuntime`
(`"system"` / `"managed"`, the tmux executable) separately on `PUT /api/servers/:name`.
The former `muxRuntime: "misao"` is still accepted as `defaultMux: "misao"` for compatibility, and will be removed in the next release.

## Agent servers

An agent server can run misao too. The hub keeps **one misao connection per server**: a local server uses the hub's own daemon, an agent
server uses the daemon on its host, reached through the agent.

- **Relay.** The agent serves `/ws?mode=misao`, a byte-for-byte relay between a WebSocket and the agent's own misao socket
  (`MISAO_SOCKET` in the agent's environment, otherwise `~/.azito/misao/misao.sock`). The hub's SDK speaks its protocol through it
  (`MisaoClient({ connect })`), so windows, terminals, task output lines and activity events work as on a local server.
- **Security.** The relay hands over the daemon's full authority (it runs arbitrary commands as the agent's user), so it is guarded exactly like
  `/api/exec`: the agent token, and the agent's bind address (a Tailscale IP, never `0.0.0.0`). The socket is fixed by the agent at startup:
  nothing in the request (a path, a query) can name another one. At most 128 relays are open at once.
- **Task output.** Lines come from the server's own connection; the completion signal file lives on the agent host and is read through
  the agent's file-tail, like for tmux.
- **Listing.** An agent server lists misao only where it was set up (default mux, a misao window on record, or a daemon socket the agent
  reports). A server without it shows no `unavailable` misao entry; asking for a misao window there answers `409 mux_kind_unavailable` with reason `not_installed`.
- **Isolation.** A misao window of an isolated server gets the same credential mask as a tmux one (`composePaneEnv`): `AZITO_UI_TOKEN`,
  `AZITO_AGENT_TOKEN` and `AZITO_WEBHOOK_TOKEN` are blanked, whatever the daemon itself inherited. The hub's webhook token is passed as
  ephemeral env, so the daemon does not persist it.

### Installing misao on an agent server

The hub sends **its own bundled misao** through the agent (the release files are checked against the manifest sha256 on both ends; the
agent downloads nothing). Every hub carries the binary for all five targets: the four Unix ones and `x86_64-pc-windows-msvc` (`misao.exe`). (the hub installs its own misao from the same bundle, and hubs run on
Linux x86_64 / arm64 and macOS arm64) and sends the one that fits the agent's own OS / architecture
(Linux x86_64 / arm64, macOS arm64 / x86_64; any other host is refused with an error, there is no fallback). In practice the agent
installer of this release accepts x86_64 hosts only, so an arm64 agent server is not supported yet; that is a separate matter from what the hub bundles. It is installed under
`~/.azito/misao/<version>/` with `current` -> `<version>` and started as the `azito-misao` systemd user unit (`KillMode=process`), or as a background
process (cleared environment, no reboot survival) when the host has no user systemd (always the case on macOS). No Node.js or node-pty is involved. Installing on a Windows hub comes with the Windows hub support (until then a Windows hub reports the misao status `unsupported_platform` and install / update fail with `not_managed`). Building a release needs the `unzip` command to unpack the Windows build. Installing on a Windows agent is the next section.

#### Installing on a Windows agent

The Windows build (`x86_64-pc-windows-msvc`) goes through the agent the same way (`PUT /api/misao/upload`; the file is `misao.exe`), is checked by sha256 on both ends and
placed in `%USERPROFILE%\.azito\misao\<version>\`. There is no symbolic link: the current release is the **file `<root>\current` (it holds the version)** and the **absolute path of
`misao.exe` written into the task definition**. `<root>` is made owner-only (the ACL mechanism of the Windows agent install). Everything done on the host goes through the agent: PowerShell
(`-EncodedCommand`, run by `/api/run`), `schtasks.exe` and the file API. No sh is involved.

- **Service**: the Task Scheduler task `AzitoMisao`, started at the user's logon. It runs `conhost.exe --headless cmd.exe /d /c ""<root>\<version>\misao.exe" serve --socket "<pipe>" --data "<root>" >> "<root>\misao.log" 2>&1"`:
  no window appears, and `cmd.exe` appends the log (misao has no option of its own for a log file). The working directory is the user's home folder (so that no pane starts inside a release folder and
  keeps it from being deleted). It is restarted after one minute only on a failure (non-zero exit), not after `misao stop` (exit 0). The task does not run while the user is logged off, so neither does the daemon.
- **Endpoint**: the named pipe `\\.\pipe\misao-<user>-<first 16 hex digits of sha256(lower-cased <root>)>` (the name @misao/sdk's `resolveSocketPath` gives for `MISAO_DIR=<root>`; a test compares them). The agent decides it once at startup and uses
  `MISAO_SOCKET` if that names a pipe. The relay (`/ws?mode=misao`) and `GET /api/misao/status` / `PUT /api/misao/upload` work on Windows too. `socketPresent` means "the pipe accepts a connection"; a pipe does not outlive its server, so that is "the daemon is up".
- `install()` makes the same promises as on Unix. It **never stops or switches a running daemon** (an older release running is left alone, the new one is put beside it and `updateAvailable` says so; a daemon AZITO did not install is refused). When nothing is running it starts one.
- `update()` (`POST /api/servers/:name/update-misao`): `misao.exe stop` of the previous release (through the pipe; the daemon closes the panes and exits with code 0) -> switch `current` and the task -> start. If it does not stop, the task is ended and the
  `misao.exe` processes of this user whose command line has `--socket <pipe>` are ended; if it still does not stop, nothing is changed and the update fails. If the switch fails, the previous `current` and task definition are put back and the previous release is started (as on Unix).
- **Panes** open the shell the agent reports (`%ComSpec%`, cmd.exe: misao's own default), without a command. A window that launches a worker (claude / codex) is #371 and is `unsupported_os` for now.
- For trials, the task name and the folder can be changed with `AZITO_WIN_MISAO_TASK_NAME` / `AZITO_WIN_MISAO_DIR` on the hub (the same mechanism as `AZITO_WIN_AGENT_*`). The folder is written into the agent's settings file as `AZITO_MISAO_DIR`, only when it is not the default.
- On a host with no logon session the task cannot start (last result `0x8004130f`); the install then fails with `daemon_not_ready` and removes the task and `current` it made.

- When you add an agent server (auto-install), misao is installed after the agent. A host without tmux no longer fails the preflight, and its
  default mux becomes misao. If only the misao step fails, the agent stays installed and the response carries `misaoError`.
- When you create a misao window on a server that has none, the UI asks first, then calls `POST /api/servers/:name/install-misao`
  (operator only, also in compat mode; `GET` on the same path reports the progress). The Setup row of the server has the same button, with progress and errors.
- An update of the agent (`AgentUpdater`) never stops or restarts the misao daemon. A daemon of another release than the bundled one is left
  as it is (the Setup row says so): switching it ends every pane.
- A hub run from a source checkout carries no bundled misao, so it cannot install one on an agent server.
- **Updating a running agent-side daemon** (for example a 0.2.0 Node build) to the bundled release is an explicit action: the "Update misao"
  button on the Setup row (shown only when the running release differs; a confirmation dialog first, because every pane of that server ends), or
  `POST /api/servers/:name/update-misao` (operator only, also in compat mode; progress through the same `GET`). It saves the previous `current`
  link and unit file, stops the daemon (the systemd unit, `misao stop`, then a SIGTERM to the process whose command line names the managed socket, which also
  covers a daemon started in the background), switches `current` and the unit, starts the new one and waits for its socket. If any step fails,
  the previous link and unit file are put back and the previous release is started again. An install on a host where nothing is running behaves the same
  way for the unit and link (restored on failure).
- Not covered yet: startup recovery of stuck tasks (local servers only).

## When it cannot connect

If the Overview shows "Cannot connect to misao. You can check it from a terminal with misao status.",
the hub cannot reach the daemon.

- Run `misao status` to check that the daemon is running.
- Check that `MISAO_SOCKET` in the hub's environment (or `~/.misao/misao.sock` when unset) is the daemon's socket.
- On a release build, `azito misao status` shows whether the service is running, how it differs from the bundled version, and whether the hub needs a restart. If the protocol does not match it says "incompatible"; switch to the bundled version with `azito misao update`.
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
- misao on SSH servers and the managed tmux install flow are out of scope.
