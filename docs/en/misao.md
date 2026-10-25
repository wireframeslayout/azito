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
process (cleared environment, no reboot survival) when the host has no user systemd (always the case on macOS). No Node.js or node-pty is involved. Installing on a Windows hub is the section "The hub's own misao on Windows" below. Building a release needs the `unzip` command to unpack the Windows build. Installing on a Windows agent is the next section.

#### Installing on a Windows agent

The Windows build (`x86_64-pc-windows-msvc`) goes through the agent the same way (`PUT /api/misao/upload`; the file is `misao.exe`), is checked by sha256 on both ends and
placed in `%USERPROFILE%\.azito\misao\<version>\`. There is no symbolic link: the current release is the **file `<root>\current` (it holds the version)** and the **absolute path of
`misao.exe` written into the task definition**. `<root>` is made owner-only (the ACL mechanism of the Windows agent install). Everything done on the host goes through the agent: PowerShell
(`-EncodedCommand`, run by `/api/run`), `schtasks.exe` and the file API. No sh is involved.

- **Service**: the Task Scheduler task `AzitoMisao`, started at the user's logon. It runs `conhost.exe --headless cmd.exe /d /c ""<root>\<version>\misao.exe" serve --socket "<pipe>" --data "<root>" >> "<root>\misao.log" 2>&1"`:
  no window appears, and `cmd.exe` appends the log (misao has no option of its own for a log file). The working directory is the user's home folder (so that no pane starts inside a release folder and
  keeps it from being deleted). **A folder whose path has any character other than ASCII letters, digits and `. _ : ~ \ -`** (a space, a parenthesis, `&`, `%`, `!`, a non-ASCII user name...) cannot be written into that command line: `conhost.exe` re-reads it and the task then starts nothing, whatever the quoting. Such a task runs a fixed PowerShell launcher instead (`conhost.exe --headless powershell.exe -EncodedCommand ...`) that starts the same `cmd.exe` line with the paths in environment variables, so no path is in the command line; folders of plain characters keep the form above. The pipe name is made from the folder's real spelling (8.3 short names such as `RUNNER~1` and junctions are resolved by `resolveRealPath`: the nearest existing ancestor is resolved and the part not created yet is joined unchanged, so the answer is the same before and after the folder exists). The host that owns the folder resolves it ONCE at its entry point (the hub for its prefix, an agent for its home, and it reports the resolved `misaoRoot`); `windowsMisaoPipe`, the task definition and the ownership check only compare strings, and the hub never looks up an agent's path on its own file system. The ownership check reads the folder the task starts (`--data`, or the launcher's `AZITO_MISAO_ROOT`) and compares it with the resolved root, not text inside the XML. An agent whose daemon already runs on a pipe made from a short spelling is not stopped by this: install / update see the running task and refuse (`daemon_not_ready`, nothing changed), and the daemon is moved to the real-spelling pipe by the next stop and update. The task's RestartOnFailure never fires for it (`conhost.exe --headless` reports exit code 0 whatever happened to the daemon, and the Task Scheduler does not restart a task for a non-zero exit code either; measured on Windows CI), so **the hub starts the task again** while it runs: it looks at each Windows agent every 15 s, and a daemon that is installed by AZITO but does not answer (the agent being reachable) is started again through the agent (`schtasks /Run`) after about a minute, then at doubling intervals up to 15 minutes; later attempts end a task that stays "running" without a daemon first. Nothing restarts it while the hub is down. A daemon stopped by hand (`misao stop`, `schtasks /End`) cannot be told from a dead one, so it is started again too: to keep it stopped, remove the server from the hub or disable the task (`schtasks /Change /TN AzitoMisao /DISABLE`; the hub skips a disabled task without a word). The hub only touches the managed daemon: an agent that relays to another pipe (`MISAO_SOCKET`), a misao that AZITO did not install, and a task that starts another folder's misao are left alone (a warning, once). The task does not run while the user is logged off, so neither does the daemon.
- **Endpoint**: the named pipe `\\.\pipe\misao-<user>-<first 16 hex digits of sha256(lower-cased <root>)>` (the name @misao/sdk's `resolveSocketPath` gives for `MISAO_DIR=<root>`; a test compares them). The agent decides it once at startup and uses
  `MISAO_SOCKET` if that names a pipe. The relay (`/ws?mode=misao`) and `GET /api/misao/status` / `PUT /api/misao/upload` work on Windows too. `socketPresent` means "the pipe accepts a connection"; a pipe does not outlive its server, so that is "the daemon is up".
- `install()` makes the same promises as on Unix. It **never stops or switches a running daemon** (an older release running is left alone, the new one is put beside it and `updateAvailable` says so; a daemon AZITO did not install is refused). When nothing is running it starts one.
- `update()` (`POST /api/servers/:name/update-misao`): `misao.exe stop` of the previous release (through the pipe; the daemon closes the panes and exits with code 0) -> switch `current` and the task -> start. If it does not stop, the task is ended and the
  `misao.exe` processes of this user whose command line has `--socket <pipe>` are ended; if it still does not stop, nothing is changed and the update fails. If the switch fails, the previous `current` and task definition are put back and the previous release is started (as on Unix).
- **Panes** open the shell the agent reports (`%ComSpec%`, cmd.exe: misao's own default), without a command. A window that launches a worker (claude / codex) is #371 and is `unsupported_os` for now.
- For trials, the task name and the folder can be changed with `AZITO_WIN_MISAO_TASK_NAME` / `AZITO_WIN_MISAO_DIR` on the hub (the same mechanism as `AZITO_WIN_AGENT_*`). The folder is written into the agent's settings file as `AZITO_MISAO_DIR`, only when it is not the default.
- On a host with no logon session the task cannot start (last result `0x8004130f`); the install then fails with `daemon_not_ready` and removes the task and `current` it made.

#### The hub's own misao on Windows

A Windows hub installs its own misao with the **same installer an agent gets** (`MisaoWindowsInstaller`), aimed at the machine it runs on (`misaoLocalWindows.ts`: its commands, files, pipe probe and staging run in-process instead of through an agent). So there is one definition of the layout, the task and the stop / switch / start / roll-back steps, and the promises above hold unchanged: install never stops or switches a running daemon, update stops with `misao.exe stop`, switches, starts, and puts the previous release back on failure. A hub update, a hub restart and `azito stop` never touch the daemon.

- **One misao per user.** The folder is `<prefix>\misao` (the default prefix `%USERPROFILE%\.azito` makes it `%USERPROFILE%\.azito\misao\<version>\misao.exe`, with the licenses), the task is `AzitoMisao`, the release is named by the file `<root>\current` and the pipe is the one of that folder (`\\.\pipe\misao-<user>-<hash of the folder>`). A Windows agent on the same machine uses the same folder, task and pipe, so the two share one daemon instead of fighting over the task name. A task that starts a misao from **another** folder (another prefix, another install) is refused by install, update and start; `azito misao install --replace-socket` takes it over on purpose.
- **When the hub's own misao dies (Windows).** The same reason as for an agent's (`conhost.exe --headless` reports exit code 0, nothing restarts the task), and the same remedy aimed at this machine: while the hub runs, `LocalMisaoWatchdog` looks every 15 s, and a daemon that `azito misao install` installed here (the hub's `MISAO_SOCKET` is the managed pipe, the task starts this folder's misao) but that does not answer is started again through its task after about a minute, then at doubling intervals up to 15 minutes; later attempts end a task that stays "running" without a daemon first. It shares the one-at-a-time slot of `azito misao install|start|update` and the Setup row's update, **across processes** (the CLI runs in its own process): the slot is a Windows named pipe made from the misao folder (`\\.\pipe\azito-lock-<hash of the folder and its secret key>`; the key is 32 random bytes in `<prefix>\misao\.lock-key`, made once through the secret-file guard so that only you can read it: any user can create a pipe, so a name made from the folder alone could be taken first by another user and keep the watchdog from reviving the daemon, while without the key nobody else can work the name out. A key file that is not owner-only or not a key fails the operation with the reason, never falls back to no key. A connection made to the holder lives for 2 seconds at most from the moment it connected, and all of them are destroyed on release, so a client that never goes away cannot hold the release up). **What this cannot stop:** another user on the same machine can see the pipe's name while the slot is held and create the pipe first once it is released. So when the slot is taken, Windows is asked which process serves the pipe (`GetNamedPipeServerProcessId`, never what the holder says about itself) and whose it is (the owner SID): a process of this user is just `busy` (try again later, with its process id); a process of another user, or one whose owner cannot be told, stops the operation with the reason "a process of another user (<pid>) holds the lock: it may have taken the name first" (`lock_foreign`) instead of waiting on it. The automatic recovery then does not count it as an attempt and writes the reason to `hub.log` once per reason, not on every look; `azito misao install|start|update` stop for the same reason, since they take the same slot. It is detected and reported, not prevented: until that process is gone (or the other user is told), the automatic recovery cannot run on that machine: whoever listens on it holds the slot, a second listener is refused, and the OS frees it when the holder ends however it ends, so there is no stale lock to judge. An install / update / revive that the hub runs **through a Windows agent** takes the same slot when that agent reports the very same misao folder as the hub's own (an agent on this machine, as this user, sharing this daemon), so the watchdog cannot touch the daemon in the middle of a co-located agent's update either. The match is by the folder's name alone: an agent on another machine that happens to report the same path (same user name and prefix) is serialised with it needlessly, never let through wrongly; an agent with another folder is covered by the per-server mutex only, as before. While another process holds it the watchdog does nothing and looks again at the next tick, so an update is never interrupted; `azito misao install|start|update` that finds it taken stops at once with the holder's process id (it does not wait: an update closes every pane, so trying again is your choice). Only the Windows hub's misao is locked this way: on Linux and macOS (systemd / launchd) nothing starts the daemon on its own, so there is no watchdog to keep apart, and the CLI and the hub are left as they were. A `MISAO_SOCKET` set to another daemon by hand, a task that starts another prefix's misao and a task disabled by hand (`schtasks /Change /TN AzitoMisao /DISABLE`) are left alone. **Limit:** nothing restarts misao while the hub is down; the hub comes back by its own launcher (`install-and-update.md`), and then brings misao back.
- **Prefix.** Spaces, parentheses, `&`, `%` and `!` are fine (`C:\Users\Foo Bar (Work)\.azito`: the task then runs through the launcher script described above); a quote and line breaks are refused. The Unix checks are unchanged. A pipe has no length limit like a unix socket's 107 bytes.
- **Connection.** `azito misao install` writes `MISAO_SOCKET=<pipe>` into `<prefix>\hub\.env` once the daemon answers; `run.ps1` loads that file before the hub starts, so the hub resolves the pipe from `.env` (the SDK's own default would be another folder's pipe). `GET /api/system/misao` shows `needsHubRestart` while the running hub still uses another one. For a new database, the local server defaults to misao when `MISAO_SOCKET` is set or the `AzitoMisao` task exists (`hasMisaoToRelyOn`).
- **Commands.** `azito misao status|install|update|start` and the Setup row's buttons (`GET/POST /api/system/misao...`) work as on Unix; `serviceManager` is `taskscheduler`, and no systemd / launchd unit is ever written for a Windows host. `install.ps1` calls `azito misao install --prefix <prefix>` after registering the hub's task (not with `-NoService`, as `install.sh` does not with `--no-service`); a failure is a warning, and `azito misao install` repeats it.
- **The local server runs misao only** (#380 B4a). `hostFeatureSupport(profile, 'tmux')` is the one place that closes tmux for a Windows host, and the server side reads it too: `SqliteServerRepository` stamps the hub's own host on a local server (`hostProfile`, never stored) and reads a stored `tmux` default as `misao` there (the row is left as it is); `supportedMuxKinds` lists misao only; the tmux driver is registered with `registerTmuxDriver` (not `hosted` on a Windows host, `unsupported_os` when asked: `POST .../mux/workspaces {kind:'tmux'}` is a 409 `mux_kind_unavailable` with that reason); `LocalTransport.execMux` / `openTerminal` refuse a stray tmux call the same way. Out of scope, quietly (one info line at startup, no error loop): `TmuxHookManager` hooks, the startup linked-session GC, the tmux row of `install-status`, `install-tmux` (501 `unsupported_os`) and a `PUT` of `defaultMux: tmux` (501). tui-supervisor is never used for a misao window, and the tier 2 / 3 / 4 tmux captures only look at tmux windows, of which a Windows hub has none. A Unix hub is unchanged (tmux and misao side by side).
- **Panes.** The pane shell of the hub's own misao on Windows is `%ComSpec%` (cmd.exe), opened bare (`hubPaneShell`, `commandArgs: null`, like a Windows agent's). A window can be created, renamed, deleted, typed into (`send-keys`), read back (`capture`) and attached through the browser terminal WebSocket (ConPTY is misao's). **A worker (claude / codex / a command) is not typed into a pane on Windows, and no shell pane is replaced** (#371). `WorkerLaunch` (`agents/WorkerLaunch.ts`) is the one definition of a launch; a POSIX host renders it as a shell line (`renderLaunchLine`) and types it. A Windows host (`workerStartsAsProgram`) gets the worker as **the first pane of the window it is created with**: `openWorkspace` / `openWindow` take `program: { argv, cwd, cols, rows }` and misao's `pane.open` starts it (no PowerShell / cmd.exe quoting, no `cd` line; misao resolves `claude` to `claude.cmd` with the child's PATH / PATHEXT and names the pane's profile after the program, so `tier0_mux` can report `blocked`); the pane's env is the call's own env. If the program cannot be found, the window (and a workspace the call created) is removed. The pane is started at the UI's default terminal size (120x40, `tmux/terminalSize.ts`) because a Node TUI on Windows does not follow a later ConPTY resize. Add Window is one call on such a host (`POST /mux/workspaces[/:ws/windows]` with `launch`, answering `agentSessionId`); an agent cannot be started in a window that already exists (`launch-agent` is `unsupported_os` there). `WindowRespawnService.respawn` recreates the window, so it creates it with the worker as the first pane. A command line (a generic worker, the Add Window command) is split into arguments only when it is plain words and `'single quoted'` words (`splitCommandLine`); anything with shell syntax is `unsupported_os`, and every word of the argument list must be free of cmd.exe's `% ^ & | < > " ! ( )` (a `.cmd` shim is run through cmd.exe). A `~` working directory is expanded before `pane.open`. Respawning a window with a saved pane layout, a plain shell window with a working directory, or a generic / custom-command worker window (its command is not stored) is `unsupported_os` for now, refused before the window is destroyed; the respawn of an agent window destroys the old window before creating the new one, so a program that cannot be found (PATH / PATHEXT) leaves no window, and the error says so; and respawning a window a task owns works the same way. Task execution (T6 of #371) makes the task's worktree first, so the worker is the first pane of the window created in it: `execute`, `followUp` (a sleeping or lost window is created again, not woken), `resumeStateMachine` and `TaskRestoreService.restore` all start the worker as a program; only `resumeLegacySession` (a task without a window record, which predates Windows support) is refused. `requireCommandArgs` still refuses opening a pane with a command line (`openWorkspace`/`openPaneInWindow` with `command`).
- **Activity.** The daemon's `pane.state` events reach `tier0_mux` as on Unix (`GET /api/debug/activity` lists a registered agent window of the Windows hub's local server). Windows CI (`smoke-misao-win32.ts`) drives the real `misao.exe`: create, rename, send-keys, capture, one terminal round trip, `tier0_mux` in the diagnostics, the worker refusal and the delete.

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
