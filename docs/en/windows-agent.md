# Windows agent servers

This page is about using a Windows machine as an AZITO agent server over SSH. It reads in order: prepare, add, what works, update, remove, limits, troubleshooting.

- Running the **hub** (AZITO itself) on Windows is covered in [Install and Update](./install-and-update.md), "Windows bundle". The hub and the agent are different things; one Windows machine can have both.
- The hub's own **in-app update** on Windows is the "Updates" section of that page (#381). This page covers how the hub updates a Windows agent ([Update](#update)).
- Details by area: [Files](./files.md#file-features-on-a-windows-server), [Task execution](./tasks.md#running-tasks-on-a-windows-agent-371), [Harness](./harness.md#windows), [misao](./misao.md#installing-on-a-windows-agent).

## Prepare

What to have on the Windows host. No administrator rights are needed or asked for (adding the firewall rule is the one thing that may need an administrator: see [Without administrator rights](#without-administrator-rights)).

| Prerequisite | Detail |
|---|---|
| OpenSSH Server | Enabled on the Windows host and reachable from the hub. The default shell may stay **cmd.exe** (PowerShell also works): the hub reads the OS first and then runs its checks as a PowerShell script that behaves the same under both. The SSH user is the user the agent will run as |
| Windows | x64 only, judged by the OS's native architecture (Windows on ARM is refused with the reason, even under x64 emulation). Windows 10 version 1809 (build 17763) or later, Windows Server 2019 or later (for `tar.exe` and `conhost.exe --headless`; checked by the preflight). The edition (10 / 11 / Server) is only displayed, not checked |
| Node.js v24+ | On the PATH of the SSH session |
| Git for Windows | `git.exe` installed (`winget install --id Git.Git -e`; AZITO does not bundle it). Task worktrees and the git features of the file screens use it. The agent's host looks for it itself: PATH first (with the `PATHEXT` extensions), then the standard locations `%ProgramFiles%\Git\cmd\git.exe`, `%ProgramFiles(x86)%\Git\cmd\git.exe` and `%LOCALAPPDATA%\Programs\Git\cmd\git.exe` (a per-user install). An agent started by the Task Scheduler gets a minimal environment whose PATH may lack it, and right after winget the PATH does not have it until the next logon. Only `cmd\git.exe` is looked for in the standard locations, not `bin\git.exe` (a wrapper) or `mingw64\bin`. A found path is kept, and a miss is kept for 30 seconds, so a git installed just now is found without a restart. When it is missing the git API answers `git_not_found` with the reason; the install itself is not blocked. The hub's own local server on Windows follows the same rule, found by the hub itself |
| Claude Code | The native `claude.exe` or the npm `claude.cmd` both work (found through PATHEXT). Log in once as the user the agent runs as |
| Codex | If you use it: the npm `codex.cmd` on the PATH. Log in as the user the agent runs as |
| Tailscale | Installed and signed in. `tailscale.exe` is also found at `%ProgramFiles%\Tailscale\tailscale.exe` when it is not on the PATH |
| Windows Firewall | Must allow inbound TCP 3002 for `node.exe`, and have no Block rule for it (step 1 of [Add](#add)) |

Claude Code and Codex are needed to run tasks. Files, git and the terminal work without them.

### Without administrator rights

Installing, updating and removing work when the SSH user is **not an administrator** (the Task Scheduler task is registered with that user's own rights). Three things differ:

- **AZITO cannot add the firewall rule itself.** An elevated (administrator) SSH session lets the install add it. Without elevation, if **a covering enabled Allow rule already exists**, the install goes on without creating a rule (the firewall step of a removal is then `was not there`). Only when there is no Allow rule and none can be added does the install **stop before transferring anything** and print the command to run once in an Administrator PowerShell. Run it, then install again.
- **Some processes cannot be seen.** Removal and cleanup look for processes running from the folder, but system and other users' processes cannot be read from an ordinary user's SSH session. AZITO has a rule for your own unreadable processes ([Remove](#remove)); other users' processes are out of reach.
- **Protected processes such as Defender** cannot always be read even by an administrator ([Limits](#limits)).

## Add

Servers → Add → Agent, with the SSH address of the Windows host (`user@host:port`; Tailscale SSH `none` auth works). The hub detects the OS first. For Windows it runs the preflight (OS, architecture, version, Node, `tar.exe`, `conhost.exe`) and stops with the reason if anything is missing.

The OS is detected from one `echo AZITO_OS:%OS%:$?` (it reads no variable, so `set -u` does not matter) whose output differs between sh, cmd.exe and PowerShell; an answer that matches none of them is reported as an error, never guessed.

What the install does:

1. **Windows Firewall check.** Windows blocks inbound connections to a program until a rule allows them, and its first-run prompt appears on the desktop, never in an SSH session. The install reads every enabled inbound rule (with its port, program and address filters) and decides for TCP 3002, `node.exe` and the Tailscale IP the agent binds to:
   - An **Allow** rule counts only if it covers all of it: protocol TCP or Any; local port 3002 or Any (a **range** such as `3000-3010` is not read, so it does not count); program `node.exe` or Any; remote address Any or the tailnet range `100.64.0.0/10` (a rule **limited to other remote addresses**, e.g. LocalSubnet, does not reach the hub, so it does not count); local address Any or the agent's IP; the profile includes the one of the Tailscale adapter (`Get-NetConnectionProfile`; when that cannot be read: Any or Public). A rule that allows only the Private profile does not count when the Tailscale adapter is Public.
   - An enabled inbound **Block** rule that could stop the hub stops the install: it covers port 3002 (a range that contains it counts) for `node.exe` or any program, applies to the agent's local address, to remote addresses that include the tailnet (Any, an overlapping range, or `Internet`) and to the Tailscale adapter's profile. A Block for another port, another remote network or another profile is not counted. It is reported with its DisplayName (Windows creates one when the first-run prompt is cancelled). A Block rule wins over any Allow rule, so nothing is added beside it.
   - With no covering Allow rule and no Block rule, an elevated SSH session (an administrator) adds `AZITO Agent (TCP 3002)` for this program, this local address, from `100.64.0.0/10` only. A session that is not elevated **stops before transferring anything** and prints the command to run once in an Administrator PowerShell:
   `New-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3002 -Program "C:\Program Files\nodejs\node.exe" -LocalAddress <the Tailscale IP> -RemoteAddress 100.64.0.0/10 -Profile Any` (the real path and IP are filled in).
   - The rules in force (`ActiveStore`, group policy included) are read when the session may; otherwise only the local ones (`PersistentStore`), so a Block that group policy delivers to a host that does not let this session read it is not seen. A host that cannot answer at all (the NetSecurity module is missing) does not stop the install; the health check names the firewall if it fails. Interface-type restrictions of a rule are not looked at.
2. **Transfer** the bundle over SFTP to `%USERPROFILE%\.azito\agent\` and check its SHA256 on the host.
3. **Unpack** with the system `tar.exe` into `%USERPROFILE%\.azito\agent\<version>\` (the archive is first checked for paths that leave the folder). The folder is owner-only. There is no symlink: the task below names the version folder, so a reinstall re-registers it.
4. **Settings.** The token, bind address (the Tailscale IP) and port go to `%USERPROFILE%\.azito\agent\agent.env`, a file only the current user may read (the hub checks the ACL and refuses to go on otherwise). The agent is started as `conhost.exe --headless node.exe --env-file=<that file> <version folder>\azito-agent.cjs`, so no launcher script is involved and no console window appears on the desktop. The settings file is first created owner-only (before the token is written into it), then replaced; an earlier `agent.env` is never written to. The agent writes its own log to `%USERPROFILE%\.azito\agent\agent.log`.
5. **Service.** A Task Scheduler task `AzitoAgent` that **runs at logon of the SSH user** (user rights, restarted after a failure), then `/Run`.
6. **Health check**, the same as on Linux. A reinstall is one operation until the new agent answers: the previous task definition, settings, same-version folder and running state are kept aside and **put back** (the previous agent is started again) if the new one does not start or answer, so the hub's stored token and the host's `agent.env` never end up different. They are deleted only after the new agent is healthy.
7. **misao.** Once the agent is healthy, the bundled **misao** (the pane server) is installed: the Task Scheduler task `AzitoMisao` (runs at logon) and the folder `%USERPROFILE%\.azito\misao`; see [misao](./misao.md#installing-on-a-windows-agent). Windows has no tmux, so misao is the only pane server and the default mux of a new server is misao. If only misao fails, the agent stays installed and the reason is reported as `misaoError` beside the successful install.
8. **Harness.** Running tasks needs the AZITO harness (the `/azt-*` skills and the hooks). Install it from the server detail → Setup → Install Harness. On Windows it is installed with Node (`setup.mjs`) instead of bash; see [Harness](./harness.md#windows).

What the hub decides when you add the server (the Tailscale IP and so on) is the same as for any agent server. How the hub is reached is in [Security setup](./security-setup.md).

## What works

The hub reads the OS from the agent (`hostProfile`) and shows it on the server list and in the server's Overview. Operations are closed one by one, on the code path each takes today (the decision is one table, `hostFeatureSupport` in `@azito/shared`, with the path that closes each row in a comment). A closed entry point stays focusable (`aria-disabled`), does nothing, and shows the reason as text or a tooltip tied to it with `aria-describedby`. An operation that reaches the hub anyway is answered `unsupported_os` (501) with the reason, and the UI shows it as it is. Tasks are judged by the server they would run on, resolved with the hub's own rule (the task's server, else the project's only server).

| Feature | On a Windows agent | Reason / issue |
|---|---|---|
| Adding the server (preflight, agent install, OS detection), reinstall from Setup | Works | — |
| Update of the agent on the host | Works ([Update](#update)) | — |
| Removal of the agent on the host | Works ([Remove](#remove)) | Removal from a Linux / macOS host is #499 |
| misao (pane server), its install and update from Setup | Works. Updating misao is separate from updating the agent | — |
| New window with a plain shell | Works (cmd.exe) | — |
| Files (list, read, write, create, delete, rename: `IFileOps`), file name search, file content search (`rg` when installed, else the built-in search; result paths relative with `/`), directory completion. See [Files](./files.md#file-features-on-a-windows-server) | Works | — |
| Git diff, log, worktree switching, branch search and repository discovery | Works (needs Git for Windows; without it the API answers `git_not_found` (501) and each screen shows the reason as its error) | — |
| Task and Unit execution (execute, follow-up, restore, resume after approval, session recovery). See [Task execution](./tasks.md#running-tasks-on-a-windows-agent-371) | Works. The task's worktree is made first and the window is created with the worker as its first pane, in the worktree (no `cd`, no launch line). The prompt tells the worker to write its output and send its signals with `harness/bin/azitoctl.mjs` (Node), and the pushing phase runs `pushing-default/scripts/push.mjs` (Git for Windows' `git.exe`; `gh` / `glab` optional). Claude Code: the native `claude.exe` and the npm `claude.cmd` are both started through PATHEXT; Codex: the npm `codex.cmd` | — |
| Starting claude / codex (or a command made of plain words) in a new window, and respawning that window | Works: the window is created with the agent as its first pane (misao starts the program itself; no shell line is typed; `claude` is found as `claude.cmd` through PATHEXT). Starting an agent in a window that already exists is not available (create a new window); a command with shell syntax, or an argument with cmd.exe's `% ^ & \| < > " ! ( )`, is refused with `unsupported_os`; respawning a window with a saved pane layout, a plain shell window with a working directory, or a custom-command window (its command is not stored) is not available yet, and respawning an agent window creates the new window after the old one is gone, so a program that cannot be found (PATH / PATHEXT) leaves no window and the error says so | — |
| AZITO Harness (`setup.mjs`), its install-status row | Works | — |
| tmux (default mux choice, tmux runtime, apply tmux config, install tmux) | Not offered | Windows has no tmux; misao is the only pane server |
| Code distribution (the project's server environment option) | Not available: the option cannot be turned on for a Windows agent (the API answers 501 `unsupported_os`, the form shows the reason), and a run on a row that has it on is refused. A Windows hub can still distribute to a Linux / macOS agent | #464 |
| Isolated server (`isolationIntent`) | Not available: the API answers 501 `unsupported_os` and the server form shows the reason | #464 |
| Browser runtime (Chromium) install | Disabled in the UI | #500 (out of v0.12.0) |

A server whose OS is not recorded yet (a Unix agent registered before the OS was kept) is treated as Unix: nothing is disabled.

## Running and operating it

**The agent only runs while that user is logged on to Windows** (at the console or over Remote Desktop). After a reboot nothing starts until they log on, and logging off stops the agent. A server that survives logoff needs auto-logon or another service model, which is not offered yet. The misao task `AzitoMisao` is the same: its daemon does not run while the user is logged off.

**When it dies.** The task's RestartOnFailure never fires for the agent: `conhost.exe --headless` always reports exit code 0 for its child, and the Task Scheduler does not restart a task for a non-zero exit code either (measured on Windows CI). So **the hub brings it back while the hub runs**: it checks every Windows agent each 15 s; when one does not answer, it runs the restart (`/Query`, `/End`, `/Run` of the task, as at the hub's start) after about a minute, then at doubling intervals up to 15 minutes, and starts over as soon as the agent answers. One attempt per server at a time, never in the middle of an install or update of that server, and not for a server that was edited away. **Nothing restarts the agent while the hub is down.** An agent stopped by hand (`schtasks /End /TN AzitoAgent`) cannot be told from a dead one, so the hub starts it again: to keep it stopped, remove the server from the hub or disable the task (`schtasks /Change /TN AzitoAgent /DISABLE`; the hub skips a disabled task without a word). Unix agents are not watched (systemd's `Restart=` does that; one started with nohup is brought back only by the version check at the hub's start).

| Action | How |
|---|---|
| Restart | The hub restarts the task (`schtasks /End` then `/Run`) when it cannot reach the agent; or "Reinstall" in the Setup row |
| Stop | On the host or in an SSH session: `schtasks /End /TN AzitoAgent`, or "End" in Task Scheduler. The agent follows the `conhost.exe` the task runs and ends within a few seconds of it (an agent started by hand with `node azito-agent.cjs` does not). If Windows hands the parent's process id to another process in that moment, the agent notices within about 30 seconds (it compares the parent's creation time); if it still stays up, stop it from the Setup row (the hub ends it by its `--env-file` argument). It comes back at the next logon; add `schtasks /Change /TN AzitoAgent /DISABLE` to keep it from starting (while the hub runs it starts the agent again, [as above](#running-and-operating-it), so also remove the server from the hub or disable the task) |
| Logs | agent: `%USERPROFILE%\.azito\agent\agent.log`; misao: `%USERPROFILE%\.azito\misao\misao.log` |
| Remove | [Remove](#remove) |

To try a second agent beside the real one, set `AZITO_WIN_AGENT_TASK_NAME`, `AZITO_WIN_AGENT_DIR` (a folder under the user's home) and `AZITO_WIN_AGENT_PORT` in the hub's environment. They default to `AzitoAgent`, `.azito\agent` and `3002`. These are for trials only: they are not saved per server, so a hub started without them looks for the default task (the hub logs a line when they are in use). Use them in that temporary hub only.

## Update

When the hub starts, it checks the version of every registered agent server (the same test as for any agent: the SHA256 of the bundle). A Windows agent whose version differs is updated with the same steps as the install. If tasks are running, the update is deferred and checked again at the next hub start. To do it by hand, use server detail → Setup → Agent Server → "Reinstall", which runs the same steps.

The sequence:

1. Before anything is stopped, the firewall rule is checked the way the install checks it (if the allowance is missing, an elevated session adds the rule and goes on; otherwise the update stops here and the old agent keeps running).
2. The new version is deployed, started, and the health check awaited. **The agent's current token is reused**, so nothing changes in the hub's settings.
3. When the new agent answers, the update is committed and the previous version, settings and task that were kept aside are removed. When it does not, the previous version, settings and task are **put back** and the previous agent is started again. If the deploy fails halfway and the old agent was running, the update also checks that the old agent answers and puts the result in the error.
4. Under the lock, the server's address, token, type, OS and running state are read again; if any changed, the update is not run (`skipped`). An update that overlaps a manual reinstall never writes back an old token.

Clean-up of old versions: after a successful update, `%USERPROFILE%\.azito\agent\` keeps **only the current and the previous version**, and older version folders are removed. Only folders named with 12 hex digits (case-sensitive) are candidates; `*.prev`, scratch folders and folders you made are not touched. Links (junctions, symlinks) are not followed or removed. A folder that is in use and cannot be removed stays, with a warning, and is tried again at the next update.

misao is updated separately. Updating the agent never touches misao (so a running daemon is not stopped). Update misao yourself from the Setup row's "Update misao" (after a confirmation: stop the previous release, switch, start, and put the previous one back on failure); see `update()` in [misao](./misao.md#installing-on-a-windows-agent).

When an update fails, the error on screen says why and whether the previous agent is running. If it keeps failing, see [Troubleshooting](#troubleshooting).

## Remove

The delete-server confirmation has two choices (they apply to Windows agents only; removal from a Linux / macOS host is #499 and is manual for now):

- **Also remove the agent from the host** (on by default). Before the server is deleted, the agent is removed from the host.
- **Also remove misao (every window closes)** (off by default; available only while the first choice is on).

What happens on the host (each step answers `removed` / `was not there` / `failed` / `not done`):

- **The task `AzitoAgent`** is ended and unregistered. Only a task that is exactly what the install writes (its single Exec action matches the install's, with this host's node.exe) is touched; otherwise it is left alone and the step says why.
- **The agent folder** `%USERPROFILE%\.azito\agent` is deleted, and only when no link lies on its path up to the drive root.
- **AZITO stops no process.** If a process is still running from the folder after the task is ended, the folder is kept and the step names its pid and path for you to stop. "Running from the folder" is read widely, on purpose: a process whose program or command line contains the folder in any spelling (`/` or `\`, any case, the long or the 8.3 name, or its part below the home). A process of yours whose program or command line the host does not give is reported too. Processes of other users cannot be seen from the SSH session.
- **With "Also remove misao"**: the misao task `AzitoMisao` and the folder `%USERPROFILE%\.azito\misao` are removed too (every window closes). Ending the task does not end the misao daemon, so AZITO asks Windows which process serves the task's pipe and, only when it is a `misao.exe` of your own user lying under the misao folder, asks that daemon to stop once (`misao.exe stop` of the release the task runs). If anything else holds the pipe, it is left alone and the step says why. A misao that belongs to a Windows hub on the same host (the folder the `AzitoHub` task keeps its misao in, or any running hub process when there is no such task), or one that no scheduled task started, is left in place with the reason.
- **No firewall rule is removed.** The rule is listed with its Name and the command to remove it once you have checked it. After the server is deleted, the same list is shown in a dialog with copyable commands.

**What stays.**

- The firewall rule `AZITO Agent (TCP 3002)` (if the install added it): in an Administrator PowerShell list it with `Get-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)"`, check that it is the one the install added (an Allow for TCP 3002, for this agent's node.exe, from 100.64.0.0/10), and remove it by its Name: `Remove-NetFirewallRule -Name '<the Name>'`.
- The AZITO harness (`%USERPROFILE%\.azito\harness*`, the hooks in `~\.claude\settings.json`): not removed automatically; remove it by hand.
- misao (the task and the folder) when you did not choose "Also remove misao".

**When it fails.** If any step of the host removal fails, the server's row is not deleted. The result of each step stays on screen and you can choose:

- **Try again**: fix the cause (a process still running, for instance), then run it again.
- **Delete the entry only**: remove what is left on the host by hand.
- **Cancel**: closes the screen and keeps the server's row. Host-side removal that already succeeded (an ended task, for example) is not undone.

**An offline host.** If the host cannot be reached, the removal changes nothing on it. Turn "Also remove the agent from the host" off and delete the server's entry only; then remove what is left with the manual steps below.

By hand (when you did not use the UI, or the host was offline):

1. `schtasks /End /TN AzitoAgent`
2. `schtasks /Delete /TN AzitoAgent /F`
3. Delete `%USERPROFILE%\.azito\agent`
4. The firewall rule as above (check it, then remove it)
5. For misao too: `schtasks /Delete /TN AzitoMisao /F` and delete `%USERPROFILE%\.azito\misao` (every window closes; if the daemon is running, **before you unregister the task** read the target `misao.exe` and the `--socket` pipe from the task definition (`schtasks /Query /TN AzitoMisao /XML`) and run, in PowerShell, `$env:MISAO_SOCKET = '<the target pipe>'; & '<the target misao.exe>' stop`. Without the pipe, the stop may not reach it or may stop another daemon)

## Limits

- **It stops at logoff.** Both the agent and misao are tasks tied to the user's logon ([Running and operating it](#running-and-operating-it)).
- **Protected processes such as Defender cannot be read.** When removal or cleanup looks for processes using a folder, some processes cannot be read. AZITO counts only the kinds that can hold the folder; when a process it cannot judge remains, it keeps the folder and tells you.
- **It does not defend against a malicious process of the same user.** The safety checks of removal and cleanup (is the task the install's, does the pipe's holder belong to your misao, no links followed) prevent accidents and mix-ups. A race in which a process of the same user swaps the daemon or the folder between the check and the action is an accepted limit (that user can delete outside files anyway, so no boundary is crossed). A path mixing a long name and an 8.3 name that is missed is treated the same way.
- **Resizing a TUI.** A Node TUI (Claude Code and the like) in a Windows pane does not follow a terminal resize (ConPTY resize). Panes start at 120x40, so resizing the browser window may not change how the TUI draws. This is a known limit on the misao side.
- **Code distribution, isolation and the browser runtime are not available** (the table in [What works](#what-works)).
- **Windows panes are cmd.exe, and a command with shell syntax cannot be started** (the same table).

## Troubleshooting

| Symptom | Cause and steps |
|---|---|
| An operation is refused with `unsupported_os` (501), or an entry is greyed out with a reason | That feature is closed on a Windows host. The reason is shown as it is. Closed: tmux, code distribution (#464), isolation (#464), the browser runtime (#500), removal from a Linux / macOS host (#499), starting a command with shell syntax, and some respawns ([What works](#what-works)) |
| The git screens or tasks fail with `git_not_found` (501) | Git for Windows is not installed on the host. Install it with `winget install --id Git.Git -e` (no restart needed; a miss is forgotten after 30 seconds). The standard locations are in the [Prepare](#prepare) table; the places searched are in the error too |
| The install stops and prints a firewall command | The SSH session is not an administrator and no Allow rule exists. Run the printed command once in an Administrator PowerShell, then install again (step 1 of [Add](#add)) |
| The install stops and names a Block rule | An inbound Block rule would stop the hub. Check it and disable or remove it. A Block wins over any Allow, so AZITO does not add an Allow beside it |
| The agent cannot be reached (offline, `401`) | Check in order: (1) is the user logged on (logging off stops it); (2) is the task `AzitoAgent` running (`schtasks /Query /TN AzitoAgent`) and not disabled; (3) does the firewall allow TCP 3002 and have no Block; (4) is Tailscale connected on both ends; (5) token: a 401 means the token the hub holds differs from the host's `agent.env`. "Reinstall" in the Setup row aligns them (a reinstall can be put back until the new agent answers) |
| An update fails | The error on screen says why, and the previous agent is running or has been put back. If it stopped halfway, `*.prev` (the previous version and settings set aside) may remain in `%USERPROFILE%\.azito\agent\`. **The next install or update will not go on while a `*.prev` remains.** The error names what is left: if the installed agent works, delete them; otherwise move each back to its name without `.prev`; then run it again (AZITO never deletes them itself, because they may be the only copy of the settings whose token the hub holds). A busy old version folder gets a warning and is removed at the next update |
| A removal stops with `failed` | Read each step's result. (1) The task is not the install's: it is left alone; delete it with `schtasks /Delete /TN AzitoAgent /F` if it is not needed. (2) A process runs from the folder: stop the process at the pid and path shown, then "Try again". (3) An unreadable process of yours: check it in Task Manager and stop what is not needed. (4) misao was not done: read the reason (a Windows hub's, one no task started, and so on). If it is the hub's, do not remove it. (5) If nothing helps, use "Delete the entry only" and remove what is left by hand |
| A task fails with `bypass_permissions_dialog` | Claude Code's "Bypass Permissions mode" confirmation appeared. Before it starts a Claude worker AZITO writes the acceptance into the host's `~\.claude\settings.json` ([Tasks](./tasks.md#claude-codes-confirmation-dialog-bypass-permissions-mode)). If it still appears, start `claude --dangerously-skip-permissions` once by hand on the host and accept it. A file with broken JSON is not rewritten; see the reason in the execution log |
| A Codex task stops at the folder trust prompt | Codex may ask to trust a folder on its first run there. Unlike Claude Code, AZITO does not write Codex's trust beforehand. Start `codex` once by hand in that folder on the host and trust it (accepting it in a window made with Add Window works too). Confirmation on a real host is in progress |
| The task window does not open, or `claude` / `codex` is not found | The program is not found through PATH / PATHEXT. Check the PATH of the user the agent runs as (an agent started by the Task Scheduler may get a minimal environment; after changing it, log on again or reinstall from the Setup row) |
| The misao task does not run for a folder with Japanese characters or spaces | As described in [misao](./misao.md#installing-on-a-windows-agent), such a path goes through a PowerShell launcher script. If it still does not start, read the log file (`misao.log`) |

## How this relates to a Windows hub

- Running the hub itself on Windows (install, running as a Task Scheduler task, its limits) is in [Install and Update](./install-and-update.md#windows-bundle). The hub's in-app update is the "Updates" section of the same page (#381).
- Preparing a Windows hub to use SSH / agent servers, Windows agents included (ssh-agent, keys, host keys), is in [Using SSH / agent servers from a Windows hub](./install-and-update.md#using-ssh--agent-servers-from-a-windows-hub).
- A Windows hub's local server is misao only (no tmux). Files and tasks behave as on a Windows agent ([misao](./misao.md#the-hubs-own-misao-on-windows)).
