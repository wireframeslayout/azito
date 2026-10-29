# Installation and Updates

## Quick Install

### One-liner

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/wireframeslayout/azito/releases/latest/download/install.sh | bash
```

To pass options:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/wireframeslayout/azito/releases/latest/download/install.sh | bash -s -- --version v0.3.0 --no-service
```

> **`| bash`, not `| sh`** — `install.sh` uses `set -euo pipefail`, which is not available in POSIX sh (dash). Using `| sh` on Ubuntu/Debian will fail immediately.

On Windows (Windows PowerShell 5.1, no administrator rights; `git` must be installed first, see [Install on Windows](#install-on-windows-installps1)):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex"
```

To pass options, call the downloaded script as a script block (`iex` cannot take arguments):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1))) -Version v0.12.0 -Port 3010 -Yes
```

`--proto '=https'` restricts the entire redirect chain to HTTPS (the `latest/download/` URL goes through two redirects before reaching `release-assets.githubusercontent.com`). `--tlsv1.2` rejects TLS 1.0/1.1 downgrade. Confirmation prompts still work under the pipe — `install.sh` reads from `/dev/tty`, not stdin.

### Review before running

Download the script, inspect it, then run:

```bash
curl --proto '=https' --tlsv1.2 -fsSL -o install.sh https://github.com/wireframeslayout/azito/releases/latest/download/install.sh
less install.sh
bash install.sh
rm install.sh
```

### Full verification (checksum)

Verifies the installer's checksum before running. Everything happens in a temp directory.

> Note: `install.sh` and `SHA256SUMS` are fetched from the same GitHub release over the same TLS connection, so this verification primarily detects transfer corruption, not tampering. The tarball itself is verified inside `install.sh` against `SHA256SUMS` after download — that check is always performed regardless of how you run the installer.

```bash
AZITO_REPO=wireframeslayout/azito AZITO_VER=latest/download; \
TMP=$(mktemp -d) && \
curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/install.sh"  "https://github.com/$AZITO_REPO/releases/$AZITO_VER/install.sh" && \
curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/SHA256SUMS" "https://github.com/$AZITO_REPO/releases/$AZITO_VER/SHA256SUMS" && \
(cd "$TMP" && grep 'install\.sh$' SHA256SUMS | { command -v sha256sum >/dev/null && sha256sum -c - || shasum -a 256 -c -; }) && \
bash "$TMP/install.sh"; rm -rf "$TMP"
```

Append installer options to the last command (e.g. `bash "$TMP/install.sh" --no-service`).
For a specific version, change `AZITO_VER=download/v0.3.0-rc2`.

### install.sh options

| Flag | Description | Default |
|------|-------------|---------|
| `--version <tag>` | Version to install | latest |
| `--prefix <dir>` | Installation prefix | `~/.azito` |
| `--no-service` | Skip systemd/launchd setup | - |
| `--yes` | Skip confirmation prompts | - |

### Host prerequisites

The release bundle ships Node.js, but only to run **the hub process itself** (just the `node` binary — no npm/npx). These are still needed on the host:

| Software | Required? | Used for |
|---|---|---|
| git | **Yes** | Per-task worktrees. `install.sh` checks whether it is present and offers to install it (no version verification) |
| tmux | Optional | Only for tmux windows. AZITO's panes run on the **bundled misao**, so you can install and use AZITO without it (`install.sh` just prints a note when it is missing). 3.4+ recommended |
| Node.js v24+ | Feature-dependent | Browser runtime install (uses `npx`), supervised windows (`azs` starts the supervisor with `node`). **Not needed for the hub to boot** |
| Tailscale | Optional | Access from other devices, push notifications over HTTPS. On macOS the Homebrew locations (`/opt/homebrew/bin`, `/usr/local/bin`) are checked even when the SSH session's `PATH` lacks them |
| claude / codex CLI | Optional | Only for the corresponding workers |

misao (the headless pane server) ships inside the release. It needs no host install; `install.sh` sets it up as [a service separate from the hub](#misao-service).

The Node.js row under Servers → your server → Setup inspects the *host*, not the bundled runtime. Leaving it uninstalled is fine unless you need the features above.

If it reports Node.js as missing even though the host has it, the service's PATH may be missing your nodenv/nvm shims (fixed in v0.3.0-rc2). On older versions, replace `~/.azito/hub/current/run.sh` with the newer one and restart the service.

## Windows bundle

Each release also carries `azito-hub-<version>-win32-x64.zip`, the hub for Windows x64: `node.exe`, the hub bundle, `public/`, `harness/`, the `deploy/` templates, the native modules built on Windows (better-sqlite3, node-pty with ConPTY) and the same misao release as the other bundles. The zip is listed in `SHA256SUMS`. It also carries `run.ps1`, the launcher (the counterpart of `run.sh`).

### Install on Windows (install.ps1)

`install.ps1` (a release asset, also in the repository root) installs it for the current user with Windows PowerShell 5.1: no administrator rights, no symlinks.

**Prepare git first.** AZITO creates a git worktree for every task, so Git for Windows must be on the PATH. The installer does not install it for you (that changes the machine beyond the install prefix); without it, it stops before downloading anything and prints how:

```powershell
winget install --id Git.Git -e --source winget
```

(without winget: <https://git-scm.com/download/win>). Then **open a new PowerShell window** and run the installer: the PATH of the window that was open during the git install does not change.

```powershell
# One-liner (the counterpart of `curl | bash`):
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex"

# With options: a script block takes arguments the way `-File` does.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1))) -Version v0.12.0 -Port 3010 -Yes

# From a file (download install.ps1 and SHA256SUMS from the release page, check install.ps1 against SHA256SUMS, then):
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Version v0.12.0] [-Prefix <dir>] [-Port <n>] [-Yes] [-NoPath]
```

All three forms do the same. The `[Net.ServicePointManager]... -bor 3072;` in front of `irm` turns on TLS 1.2 for the download of the script itself (Windows PowerShell 5.1 may not have it on by default, and GitHub requires it); the installer turns it on again for its own downloads. `iex` takes no arguments, and inside a function or script that has arguments of its own `iex` would receive them: use the script block form there. The one-liner works from v0.12.0, the first release with a Windows bundle; before that the download is a 404. The installer is written to run as text: it never ends the PowerShell it was started from (a failure is an error that stops the command and fails `-Command` with a non-zero exit), and it leaves no variable, function, `$ErrorActionPreference` change or temporary file in that session. The release's `install.ps1` carries its own tag, so the one-liner downloads the zip and `SHA256SUMS` of **that** release and does not ask for "latest" again (a release published while the installer runs cannot make the two differ); a copy from a checkout asks the GitHub API for the latest release instead.

| Option | Meaning |
|---|---|
| `-Version <tag>` | Release to install (default: the release this `install.ps1` was published with; a copy from a checkout asks for the latest release) |
| `-Prefix <dir>` | Installation prefix (default: `%USERPROFILE%\.azito`) |
| `-Port <n>` | Port of the hub (default `3001`). Written to a new `hub\.env` as `PORT`, and `AZITO_ALLOWED_ORIGINS` lists `localhost:<n>`, `127.0.0.1:<n>` and the Tailscale name with `:<n>`; the Tailscale hint (`tailscale serve --bg <n>`) uses it too. An existing `hub\.env` is never touched (a warning says so when its `PORT` differs) |
| `-ZipPath <file>` | Use a local `azito-hub-<tag>-win32-x64.zip` instead of downloading (offline installs). Add `-Sha256Sums <file>` to check it; **without it the zip is not verified** (a warning is printed) |
| `-Yes` | Skip the confirmation prompt |
| `-NoPath` | Do not add `<prefix>\bin` to the user's PATH |
| `-NoService` | Do not register the Task Scheduler task. Run the hub with `azito run`, or register it later with `azito service install` |

With `irm | iex` there is no way to pass arguments, so each option can also be given by an environment variable set before the command: `AZITO_INSTALL_VERSION`, `AZITO_INSTALL_PREFIX`, `AZITO_INSTALL_PORT`, `AZITO_INSTALL_ZIPPATH`, `AZITO_INSTALL_SHA256SUMS`, and `AZITO_INSTALL_YES` / `AZITO_INSTALL_NOPATH` / `AZITO_INSTALL_NOSERVICE` (set to `1`); an argument wins over the variable. A zip named by `AZITO_INSTALL_ZIPPATH` is never used unverified: the installer stops, before writing anything, unless `-Sha256Sums` or `AZITO_INSTALL_SHA256SUMS` names the checksum file (a variable left over in the session must not switch a normal install to an unchecked zip). Run it in a PowerShell window and remove the variable afterwards so it does not stay in the session, for example `$env:AZITO_INSTALL_PORT = 3010; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://github.com/wireframeslayout/azito/releases/latest/download/install.ps1 | iex; Remove-Item Env:AZITO_INSTALL_PORT`.

It downloads the zip and `SHA256SUMS`, stops if the checksum does not match, and refuses a zip whose entries would land outside the install folder. Layout:

```
<prefix>\hub\<version>\        the extracted bundle (node.exe, azito-hub.cjs, run.ps1, ...)
<prefix>\hub\current.txt       the installed version, one line (Windows has no `current` symlink)
<prefix>\hub\.env              configuration (outside the version folder, so updates keep it)
<prefix>\data\                 database, keys and tokens
<prefix>\bin\azito.cmd         the CLI
<prefix>\logs\hub.log         everything the hub writes to stdout / stderr (the counterpart of the journal); moved aside to hub.log.1 when the hub starts and it is over 10 MB
```

`hub\.env` and `data\` are created by the bundled hub itself (`node.exe azito-hub.cjs init-env`), so their access rules (current user only) come from the same code that protects them at run time. Running the installer again reports the existing install and changes nothing; updating by hand means extracting the new zip into `hub\<tag>` and writing the tag into `current.txt` as one line without a BOM and ending in CRLF. Without the CRLF the next in-app update fails with `current.txt must end with a CRLF`. In Windows PowerShell 5.1 `Set-Content -Encoding UTF8` and `>` add a BOM or write UTF-16, which `azito` refuses; use:

```powershell
[System.IO.File]::WriteAllText("$env:USERPROFILE\.azito\hub\current.txt", "v0.12.0`r`n")
```

`current.txt` is written last, after the CLI and the PATH entry. If an install stopped part-way (a `hub\<tag>` folder without `current.txt`), run the installer again to finish it; `hub\.env` and its token are kept.

The CLI reads `current.txt` and runs the bundled hub:

| Command | Effect |
|---|---|
| `azito start` / `azito stop` / `azito restart` / `azito status` | Start, stop, restart and show the Task Scheduler task `AzitoHub` (below). `status` prints the state and the log's place; `stop` returns when no `node.exe` of this install is left |
| `azito run` | Runs the hub in the foreground through `run.ps1` (Ctrl+C stops it): for a first look, or an install made with `-NoService` |
| `azito token show` / `token rotate` | The UI token (it is stored in `hub\.env`: `rotate` stops while it is set there, so change `AZITO_UI_TOKEN` in that file instead) |
| `azito version` | The version in `current.txt` and the bundle's own |
| `azito service status\|start\|stop\|restart\|reload\|install` | The same operations the Unix service has. `install` registers the task (install.ps1 calls it); registering the same definition again does nothing, and a different one is refused while the hub runs |
| `azito misao status\|install\|update\|start` | The hub's own misao as the Task Scheduler task `AzitoMisao` (below and `misao.md`). `install.ps1` runs `install` for you; `update` ends every pane first |

**Not supported yet:** a hub uninstaller. The in-app update is [In-app update of a Windows hub](#in-app-update-of-a-windows-hub).

### Using SSH / agent servers from a Windows hub

A Windows hub adds servers over SSH and installs / updates the Linux agent just like a Linux or macOS hub does (agents on Windows hosts: [Windows agent servers](./windows-agent.md)). Where the hub looks:

| What | Where |
|---|---|
| Private key | `%USERPROFILE%\.ssh\id_ed25519`, else `id_rsa`, `id_ecdsa` (the user's home folder, not `$HOME`) |
| ssh config | `%USERPROFILE%\.ssh\config` (`HostName` / `Port` / `User` / `IdentityFile`; the `~` of `IdentityFile ~/.ssh/key` is the user's home) |
| Host keys | `known_hosts` is not read. The first connection records the fingerprint in AZITO (trust on first use) and a changed one is refused, as on a Linux / macOS hub |
| ssh-agent | `SSH_AUTH_SOCK` if set (`\\.\pipe\...` or `pageant`); otherwise the OpenSSH named pipe `\\.\pipe\openssh-ssh-agent` |
| User name | `user@host`, else `User` in the ssh config, else the Windows user name (`USERNAME`) |

Nothing needs preparing for a plain key file (a key file protected by a passphrase cannot be used: put it in ssh-agent). To use ssh-agent, start the Windows **OpenSSH Authentication Agent** service (disabled by default). In an elevated PowerShell:

```powershell
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_ed25519   # add the key (asks for the passphrase)
ssh-add -l                                    # list the keys
```

When the service is stopped and the pipe is absent, the hub logs "no ssh-agent" once, with the reason (and the command to start it), and goes on to the key files. A hub running as a Task Scheduler task uses the same pipe, so `SSH_AUTH_SOCK` need not be set.

The common agent bundle always includes the native module for Linux x86-64 (node-pty's `pty.node`), whatever OS the hub runs on; it also carries the macOS and Windows prebuilds, so one bundle serves every agent OS. The release zip carries the same bundle as the other hub builds. After this change the bundle hash differs, so agents already installed are redeployed automatically once by the normal update. To install agents from a Windows hub built from source, prepare a node-pty folder built on Linux x64 (`package.json` and `build/Release/pty.node`) and set `AZITO_AGENT_NODE_PTY_LINUX` to its path.

### misao on Windows

Unless `-NoService` is given, `install.ps1` also installs the bundled misao (the pane server) after the hub's task, with the bundled hub: `azito misao install --prefix <prefix>` unpacks `misao.exe` and the licenses into `<prefix>\misao\<version>\` (sha256-checked against the bundle), registers the Task Scheduler task `AzitoMisao` (a logon task, `conhost.exe --headless`), starts it and writes `MISAO_SOCKET` (the named pipe) into `hub\.env`, which `run.ps1` loads when the hub starts. It is the installer an agent server gets, aimed at this machine, so a hub with the default prefix (`%USERPROFILE%\.azito`) and a Windows agent of the same user on one machine share one daemon: the agent's misao is `~\.azito\misao`, the hub's is `<prefix>\misao`, and the pipe is made from the folder. The task name `AzitoMisao` is one per user, so with another prefix the hub's misao is not installed beside the agent's (`install.ps1` warns and installs the hub alone; `azito misao install --replace-socket` takes the task over and leaves the agent without its misao, and the agent's install and update likewise refuse while `AzitoMisao` starts another folder's misao). To use both as one user, install the hub with the default prefix. Like on Unix, misao is **separate from the hub**: a hub update, `azito restart` and `azito stop` never stop it (stopping it closes every pane); only `azito misao update` (or the Setup row's button, after a confirmation) switches it. A failed misao install is a warning and `azito misao install` repeats it. Details: `misao.md`.

### The hub as a Task Scheduler task

Unless `-NoService` is given, install.ps1 registers the task `AzitoHub` (through the bundled `azito-hub.cjs service install`: the task XML is generated by the hub's own code, never by PowerShell) and starts it with `/Run`. The task:

- starts at **your logon** (not at boot), runs as you with the least privilege (no administrator rights) and is restarted every minute when it fails. A hub does not run while you are logged off; a reboot needs a logon;
- runs `conhost.exe --headless powershell.exe <launcher>`, so no console window appears on your desktop. The launcher reads `hub\current.txt` each time it starts and runs that version's `run.ps1 -Service`, so **the definition names no version**: switching `current.txt` and `azito service restart` is all a manual update takes, and the task is never registered again;
- writes the hub's stdout and stderr to `<prefix>\logs\hub.log` (a launcher that finds a bad `current.txt` writes its reason there too); `azito status` prints the place;
- ends with the task: the Task Scheduler's "End" (`azito stop`, `schtasks /End /TN AzitoHub`) ends only the `conhost.exe`, so `run.ps1 -Service` names it to the hub (`AZITO_HUB_EXIT_WITH_PID`) and the hub shuts down within seconds when it is gone, the way the Windows agent follows its parent. `azito stop|restart|reload` finds the hub's `node.exe` (any version folder under `<prefix>\hub\`, same user, exact command-line argument) before it ends the task, waits up to 20 s for it to shut down by itself, and ends forcibly only what is still the same process after that (the warning says so). A restart after `current.txt` was switched therefore waits for the old version, and the new one never meets it on the port. It touches no other prefix, no other user and nothing else.
- **comes back from a crash by itself.** `conhost.exe --headless` reports exit code 0 whatever its child did, and the Task Scheduler does not restart a task for a non-zero exit code either (measured on Windows CI), so the **launcher** does it: when the hub ends with a non-zero exit code (a crash, `Stop-Process -Force`, an out-of-memory kill), the launcher starts it again after 5 seconds, then 10, 20, 40 and at most 60 seconds between starts, starting over from 5 seconds once a hub has run for 5 minutes. Each start reads `current.txt` again; a bad one is written to the log and retried every 60 seconds. The launcher names its `conhost.exe` (id and start time) to `run.ps1 -Service -FollowPid -FollowStart`, which starts no hub unless that process is still running, so an End that comes in just before a start cannot leave a hub nothing follows (it needs a `run.ps1` of this version: a task registered by this version runs the version `current.txt` names, so switch `current.txt` to a bundle of this version). A hub that shut down on purpose (exit code 0: it was told to stop, or its `conhost.exe` is gone) is **not** started again, and `azito stop|restart|reload` end the launcher with the task, so there is nothing to switch off. Every restart is written to `hub.log` (`launcher: run.ps1 (v0.12.0) exited with code 1`, `launcher: start 2 in 5s`) and counted in `<prefix>\logs\hub-launcher.json`, which `azito status` prints as `launcher:` (the task's own Last Result stays 0 whatever happened). **Limits:** it works only while you are logged on (the task is a logon task), and a hub that fails at once on every start is tried again every 60 seconds for ever (read `hub.log`). A task registered by an earlier 0.12 build, whose launcher starts the hub only once, still answers to `azito stop`/`start`; `azito service install` (with the hub stopped) replaces it (`install.ps1` on an installed hub does nothing, so this is the step you need).

Settings → System shows the deploy mode "Task Scheduler" and the in-app update works ([In-app update of a Windows hub](#in-app-update-of-a-windows-hub)). To update by hand: extract the new zip into `hub\<tag>`, write the tag into `current.txt` (one line, no BOM, ending in CRLF), then `azito service restart`.

install.ps1 registers the task before it writes `current.txt` and starts it after, so a run that failed in between is repaired by running it again; if only the start failed, the files are installed and `azito start` is what to run. On an installed hub the installer does nothing (like `install.sh`); the task name is fixed, so there is one per user: `azito start|stop|restart|reload` refuse to touch a task registered for another prefix, `azito service install` replaces one only with `--yes` (install.ps1 passes it for `-Yes`) and never while it runs. A task that was deleted by hand is registered again by `azito service install`. Remove it by hand with `schtasks /Delete /TN AzitoHub /F` (there is no uninstaller yet; `azito status` warns when only the copy `%USERPROFILE%\.azito\service\AzitoHub.xml` is left).

### In-app update of a Windows hub

A hub that runs as the Task Scheduler task `AzitoHub` updates from Settings → System like a Linux / macOS hub. A hub run from source, or started by hand with `azito run`, cannot (the reason is shown on screen; update by hand as above). There is no Windows arm64 build yet, so an arm64 Windows cannot update from the screen either.

**Using it**

- Settings → System → "Check for updates": when the latest stable release is newer than the current one, "Update available" appears. "Update and restart" starts it.
- To pick a version, turn on "Development channel" (the rc channel). "Available versions" lists the releases; press "Install" on a row. A version older than the current one asks you to confirm the rollback. The channels work as in [Update Channels](#update-channels), the same as on Unix.
- It does not start while tasks are running; start it again after they finish.
- A progress dialog opens. The steps are "Download changes", "Verify SHA256", "Extract", "Smoke test (post-extract)", "Switch", "Restart" and "Health check". While the hub restarts it says "Waiting for server response…"; when the new version answers it shows "Update completed" and the page reloads. A failure shows "Update failed" with the reason. The dialog's log holds only this run's lines.

**The flow**

1. **A one-shot task, `AzitoHubUpdate`.** The hub registers the update as this task and `/Run`s it, rather than spawning it as its own child: the update ends the hub's own task `AzitoHub` and starts it again, and a child of the hub would end with it. The task runs the current version's `node.exe` and `azito-hub.cjs` with `update-run` (the new version is not extracted yet). It has no trigger, and the task deletes itself when the update ends.
2. **Download and check.** The zip and `SHA256SUMS` are downloaded (each is cut off after 10 minutes) and the zip's SHA-256 is compared. A mismatch fails here and nothing has changed.
3. **Extract.** Into `hub\<version>`. A zip with entries that leave the folder, or with links, is refused. If a folder of that name is already there it is never written into; it is used only if it holds everything the zip holds, otherwise the update fails and the folder is not replaced.
4. **Check with the new version.** The new version's own `node.exe` runs `azito-hub.cjs --version` (up to 30 s) and the version must match. A broken version stops here.
5. **Switch `current.txt`.** Rewritten as one line without a BOM, ending in CRLF.
6. **Restart.** The very sequence of `azito service restart`: the task `AzitoHub` is ended, the hub's `node.exe` is waited for, and the task starts again. The launcher reads `current.txt` anew, so the new version runs.
7. **Check that it started.** Up to 90 s for the new version to answer `/api/health` with its own version (a first start on Windows is slower than on Unix, which waits 30 s, because the antivirus scans what loads).

The whole update is asked to stop after 50 minutes, and ends once the step in progress (and a rollback, if one is needed) is done, not at once; the Task Scheduler's own 1-hour limit is only a backstop.

**A failure puts the previous version back.** A failure before the switch changed nothing. After the switch, `current.txt` is written back, the hub restarts and the previous version's answer is checked. The folder this run made is removed (one that was already there is not). If going back fails too, the error on screen says so. If a request to stop arrives during the health check, the update stays a success when the new version answers, and the late stop is recorded in the state's `note`.

**`azito service` is refused during an update.** `azito service install|start|stop|restart|reload` and an update never run at the same time on one install. Run during an update it ends with `Another AZITO hub operation (process N) is running on this install ... Nothing was changed`. If `azito service` is running when an update starts, the update fails with that reason.

**misao is not stopped.** misao is a separate task, `AzitoMisao`, which the update does not touch. A misao terminal in the browser disconnects while the hub restarts; reconnect and you see the same window where you left it. Updating misao is a different operation (`azito misao update`, or the Setup row's button).

**The GitHub token (`AZITO_GITHUB_TOKEN`) is never on a command line.** It is the token set in the hub's environment for a private release repository. A task cannot carry an environment variable and a command line is readable by every process on the machine, so the token goes in a file only you can read, `<prefix>\data\update-token`. The update reads it first and deletes it (the hub deletes it if the update could not start, and the next update removes any leftover). Of the values taken from the hub's environment, only the health check's address (the hub's bind address and port) goes in the task's arguments (the version, the download URLs and the folders, which do not come from the environment, do too).

**Tidying old versions.** After a successful update (never after a rollback) the old version folders in `hub\` are removed. A Unix hub keeps its old versions as before.

- Kept: the current version (`current.txt`), the version before this update (the way back), and every version a running process uses (a process whose executable or command line is under that version's folder).
- Only a real folder named like a release version the update makes (`v0.12.0`, `v0.12.0-rc.1`) is a candidate. `.staging-*`, `.env`, `current.txt` and names such as a hand-made `v0.12.0.bak.old` are not looked at. A junction or symlink with a version's name is not entered; it is left as it is and logged.
- A version to remove is first renamed to `.prune-<version>-<random>` inside `hub\` and then removed with `rd /s /q`; a junction or mount point inside is removed as the link only, never its target. A version holding a file that cannot be opened for writing (a running exe, a loaded DLL) is kept whole instead of being removed in part. A `.prune-*` left over is removed by the next update.
- **Precondition: the ACL of the `hub\` folder.** Nobody but you, SYSTEM and Administrators may be able to change `hub\`; otherwise a folder could be swapped for a link after it was checked, so the whole tidying is skipped. An install in the default place (under your user profile) normally meets it.
- **When it is skipped.** If the precondition fails, if a process whose use of a version cannot be ruled out exists, or if the process list cannot be read, nothing is removed. The update itself stays a success, also when some version could not be removed. The reason is in `update.log` and in the state's `note`, and the next update tries again. For example:
  - `Old versions that could not be removed yet (the next update tries again): v0.11.2 (...)`
  - `Could not tidy the old versions: Cannot tell whether process ... uses an old version (its path is not readable), so no old version is removed. This is usually a window of the same user that runs as administrator ...`

For trouble with an update see [Troubleshooting a Windows hub update](#troubleshooting-a-windows-hub-update).

#### Troubleshooting a Windows hub update

The records of an update are in `<prefix>\data\`.

| File | Content |
|---|---|
| `update.log` | A record by step. Every update appends, so this run is at the end. A failed step is `[<step>] ERROR: ...`; a skipped tidying is `Left ... alone` / `Could not remove ...`, and a whole tidying skipped is `Could not tidy the old versions: ...` |
| `update-state.json` | The state of the last update (`status`, `step`, each step's result, `error`, `note`). The progress on screen reads it |
| `update-run.out.log` | `update-run`'s stdout and stderr: the reason when it died before it could write its state |

| Symptom | Cause and what to do |
|---|---|
| The update does not start | The reason is on screen. (1) Tasks are running: wait for them. (2) "Already running": an earlier update is going (a state that stays `running` for 15 minutes is treated as stale and a new update may start). (3) `A task named AzitoHubUpdate exists that AZITO did not register`: a task of that name exists that AZITO cannot tell is its own. Look at it, delete it with `schtasks /Delete /TN AzitoHubUpdate /F` and try again. (4) `An update of another install ... is running`: another install's update is going; wait for it |
| The update failed | Read the reason on screen and the `ERROR` line in `update.log`. If it failed before the switch nothing changed; after the switch the previous version is back (an error says so when it could not be put back). Even on a SHA256 mismatch or a version that does not start, the hub keeps running the previous version |
| Old versions are not tidied | Read `Left ... alone` / `Could not ...` in `update.log`, or the state's `note`. **`Cannot tell whether process ... uses an old version`**: usually a window of the same user that runs as administrator (an elevated PowerShell, for example). The non-elevated hub cannot read that process's executable path, so it cannot rule out that it uses an old version and skips the tidying to be safe. Close that window and the next update tidies up. The hub never closes it. **`the hub folder can be changed by others`**: the ACL of `hub\` gives someone besides you, SYSTEM and Administrators write access; correct it and the next update tidies up. **`a running process uses it` / `cannot be opened for writing`**: end the process using that version and the next update tidies up |
| A previous update's process is left, or the lock cannot be taken | When `azito service ...` or an update keeps being refused with `Another AZITO hub operation (process N)`, look at process N. If it is the `node.exe` running `update-run`, an update is still going; it asks itself to stop after 50 minutes and ends once the step in progress (and a rollback, if one is needed) is done. If it still does not end, end that process in Task Manager (the OS releases the lock with the process). A leftover task `AzitoHubUpdate` that AZITO registered is replaced by the next update after it ends the previous `update-run` |
| I want to go back to the previous version by hand | Make sure the previous version's folder is still in `hub\` (the current and the previous version are never tidied), write its name into `current.txt` as one line without a BOM, ending in CRLF (`<prefix>\hub\current.txt`; the default prefix is `%USERPROFILE%\.azito`), and run `azito service restart`: `` [System.IO.File]::WriteAllText("$env:USERPROFILE\.azito\hub\current.txt", "v0.12.0`r`n") ``. `>` and `Set-Content -Encoding UTF8` write a BOM or UTF-16, and a `WriteAllText` without the CRLF makes the next in-app update fail, so write it exactly as above |
| It will not update to a pre-release | By default (stable) only stable releases are offered. A pre-release (`-rc.N`) is listed, and can be chosen, only with "Development channel" on. The same as on Unix |

## Manual Install (tarball)

```bash
# 1. Download from Releases
VERSION=v0.4.0
PLATFORM=linux  # or darwin
ARCH=x64        # or arm64
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/wireframeslayout/azito/releases/download/${VERSION}/azito-hub-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/wireframeslayout/azito/releases/download/${VERSION}/SHA256SUMS"

# 2. Verify SHA256
sha256sum -c SHA256SUMS --ignore-missing

# 3. Extract
mkdir -p ~/.azito/hub/${VERSION}
tar xzf azito-hub-${VERSION}-${PLATFORM}-${ARCH}.tar.gz -C ~/.azito/hub/${VERSION}

# 4. Symlink
ln -sfn ~/.azito/hub/${VERSION} ~/.azito/hub/current

# 5. Create data directory
mkdir -p ~/.azito/data
chmod 700 ~/.azito/data

# 6. Configure (.env lives outside the version directory so updates keep it)
cat > ~/.azito/hub/.env <<EOF
AZITO_DATA_DIR=$HOME/.azito/data
AZITO_UI_TOKEN=$(openssl rand -hex 32)
PORT=3001
# Opening AZITO from anything other than localhost requires listing that origin
# (it gates both CORS and WebSocket). Example: https://<host>.ts.net for Tailscale.
AZITO_ALLOWED_ORIGINS=http://localhost:3001
EOF
chmod 600 ~/.azito/hub/.env

# 7. Remove the downloaded files
rm -f azito-hub-${VERSION}-${PLATFORM}-${ARCH}.tar.gz SHA256SUMS

# 8. Install and start the misao service (writes MISAO_SOCKET into ~/.azito/hub/.env; do it before starting the hub)
~/.azito/hub/current/node ~/.azito/hub/current/azito-hub.cjs misao install

# 9. Start
~/.azito/hub/current/run.sh
```

> Important: If `AZITO_DATA_DIR` is not set, the default `~/.azito/data` is used in release mode. Data is never stored inside the bundle directory.

## Where configuration lives

**The release install (tarball / install.sh) and the source checkout (`git clone` + `npm run dev`) use different config files.** Editing the wrong one silently does nothing.

| | Release install | Source checkout (dev) |
|---|---|---|
| Config file | `~/.azito/hub/.env` | `packages/server/.env` |
| Data | `~/.azito/data/` | `<repo>/data.db`, `<repo>/data/` |
| Applying changes | `systemctl --user restart azito` (macOS: `azito service restart`) | `touch packages/server/src/main.ts` (`tsx watch` reloads) |

`~/.azito/hub/.env` sits **outside** the versioned directory (not `~/.azito/hub/<version>/`), so switching `current` during an update never loses your settings. The data directory `~/.azito/data/` holds the DB, keys and token — it is not where configuration goes.

What `install.sh` writes to `~/.azito/hub/.env`:

```bash
AZITO_DATA_DIR=/home/you/.azito/data
AZITO_UI_TOKEN=<generated>
PORT=3001
AZITO_ALLOWED_ORIGINS=http://localhost:3001[,plus your Tailscale origins if detected]
#AZITO_BIND=127.0.0.1
```

### Reaching AZITO from a new hostname

AZITO only accepts requests from listed origins (both CORS and WebSocket). Opening it on an unlisted hostname gives you a blank page, or terminals that disconnect with `1008 Forbidden origin`.

Add the origin to `AZITO_ALLOWED_ORIGINS` in `~/.azito/hub/.env` (comma-separated) and restart the service:

```bash
AZITO_ALLOWED_ORIGINS=http://localhost:3001,https://myhost.tail1234.ts.net
```

`install.sh` reads `tailscale status` at install time and adds your MagicDNS name automatically. If you enable Tailscale after installing, or use another hostname, add it by hand.

### Should you change `AZITO_BIND`?

Usually not — the `127.0.0.1` default is right. The only question is whether anything connects to AZITO's port directly.

| How you connect | `AZITO_BIND` | Origin to add |
|---|---|---|
| `tailscale serve` terminates HTTPS and forwards to localhost | `127.0.0.1` (leave it) | `https://<host>.ts.net` |
| Straight to the Tailscale IP / MagicDNS name on `:3001` | `<tailscale-ip>` | `http://<host>.ts.net:3001` |
| Browser on the same machine only | `127.0.0.1` (leave it) | none |

`AZITO_BIND` takes **a single address** — multiple addresses are not supported, and `0.0.0.0` is explicitly rejected. When a reverse proxy (such as `tailscale serve`) fronts AZITO, let the proxy own the listening surface and keep AZITO on `127.0.0.1`.

## Service Setup

### Linux (systemd)

`install.sh` configures this automatically. For manual setup:

```bash
mkdir -p ~/.config/systemd/user
cp ~/.azito/hub/current/deploy/azito-release.service ~/.config/systemd/user/azito.service
sed -i "s|__AZITO_PREFIX__|$HOME/.azito|g" ~/.config/systemd/user/azito.service

loginctl enable-linger $(whoami)
systemctl --user daemon-reload
systemctl --user enable --now azito
```

Management commands:

```bash
systemctl --user status azito
systemctl --user restart azito
journalctl --user -u azito -f
```

### macOS (launchd)

`install.sh` configures this automatically. For manual setup:

```bash
cp ~/.azito/hub/current/deploy/com.azito.hub.plist ~/Library/LaunchAgents/
sed -i '' "s|__AZITO_PREFIX__|$HOME/.azito|g" ~/Library/LaunchAgents/com.azito.hub.plist

azito service start    # bootstraps into user/<uid>
```

### macOS: the services run in `user/<uid>`, logged in or not

launchd keeps two per-user domains: `gui/<uid>` (only while that user is logged in on the Mac's screen) and `user/<uid>`
(as soon as the user has any session, an SSH login included). AZITO's hub (`com.azito.hub`) and misao (`com.azito.misao`)
always run in **`user/<uid>`**, as Background-session LaunchAgents (`LimitLoadToSessionType = Background` in the plist, which
`user/<uid>` requires and `gui/<uid>` refuses).

- **Installing over SSH on a Mac nobody is logged in on** works: both services are bootstrapped into `user/<uid>` and start right away.
- **Logging in on the screen later does not start a second copy.** The Background limit keeps macOS from loading the plist into
  `gui/<uid>`; the processes and their PIDs stay as they were. **Logging out does not stop them either.**
- **Which domain a service runs in** is shown by `azito service status` (hub), `azito misao status` and
  `GET /api/system/misao` (`serviceDomain`). After this version it is `user`.
- **Installs from before this version** (v0.11.x and earlier) were loaded into `gui/<uid>` from a plist without that limit. Whenever
  a service is started, restarted or reloaded (`azito service start|restart|reload`, the in-app hub update, `azito misao start|update`,
  `install.sh`) AZITO finds it in `gui/<uid>`, boots it out, adds the limit to the plist and bootstraps it into `user/<uid>`; if that
  fails the original plist is loaded back into `gui/<uid>`. A running misao daemon is not moved by `azito misao install`
  (moving it ends its panes): `azito misao update` does it, when you choose to.
- **After a bootout** AZITO waits until launchd has forgotten the job before it bootstraps again, and retries a few times when
  launchd answers exit 5, so `azito service reload` and an update do not leave the service stopped.
- **A failed load is an error**: `install.sh` prints `launchctl`'s message and exits non-zero; the files stay installed, and
  `azito service start` retries after the cause is fixed.
- **Loaded into both domains** (it should not happen; the migration is the only moment both could hold a copy): status shows
  `gui + user` with a warning, and `start` / `restart` / `reload` / `azito misao update` / the hub update refuse to pick one
  (`duplicate_load` from the API). Run `azito service stop` (boots it out of both) and then `azito service start`. For misao, boot
  the copies out with `launchctl bootout gui/$UID/com.azito.misao` and `launchctl bootout user/$UID/com.azito.misao` (this ends its panes), then `azito misao start`.

### macOS: the launchd hub cannot reach LAN addresses

Installing an agent at a LAN address (for example `192.168.x.x`) from a hub running as a launchd service can fail in the preflight
with `connect EHOSTUNREACH <IP>:22`. The same node run from an SSH shell does reach it, and Tailscale addresses (`100.x`) are
reachable from the launchd hub (confirmed with v0.12.0-rc.3, from a macOS 26.3.1 arm64 hub to an Ubuntu 24.04 x64 agent). macOS's
Local Network privacy permission (macOS 15 and later) is the likely cause.

- **Workaround**: use the agent's Tailscale address (or its MagicDNS name) as its address (confirmed).
- Granting the permission in System Settings › Privacy & Security › Local Network may also let it through, but this has not been confirmed yet.

The underlying fix comes in a later version ([#536](https://github.com/wireframeslayout/azito/issues/536)).

### `azito service` on an existing install

`azito service ...` (and `azito start` / `stop` / `status` going through it on macOS) needs the `~/.local/bin/azito` wrapper that this
version's `install.sh` writes. A wrapper written by an older `install.sh` is not updated by a hub update, so on an existing
install call the bundled CLI directly:

```bash
~/.azito/hub/current/node ~/.azito/hub/current/azito-hub.cjs service status    # or start | stop | restart | reload
```

To update the wrapper itself, take it from the `install.sh` of the version you have installed (it must be a release that contains this
wrapper; the installer never touches an installed hub, only the wrapper is written). The old wrapper is replaced only after the new one is checked, so a failed download leaves it as it was:

```bash
(
  set -euo pipefail
  VERSION="$(head -1 ~/.azito/hub/current/version.txt)"   # the same value `azito version` prints, e.g. v0.12.0
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/install.sh" "https://github.com/wireframeslayout/azito/releases/download/${VERSION}/install.sh"
  sed -n "/<<'WRAPPER'/,/^WRAPPER$/p" "$TMP/install.sh" | sed '1d;$d' > "$TMP/azito"
  test -s "$TMP/azito"        # not empty
  bash -n "$TMP/azito"        # valid shell
  install -m 755 "$TMP/azito" ~/.local/bin/azito
)
```

### misao service

The misao daemon runs as **a service separate from the hub** (`azito-misao`). Stopping misao closes every pane, so it is kept apart
so that hub restarts and updates never take it down.

| | |
|---|---|
| Location | `~/.azito/misao/<version>/` (the `misao` native binary for this host's OS / architecture and its licenses). `~/.azito/misao/current` points at the active version |
| Socket | `~/.azito/misao/misao.sock` (directory mode 700, path within 107 bytes). Written to `~/.azito/hub/.env` as `MISAO_SOCKET` |
| Runtime | `misao serve` (a single native binary: no Node.js, no node-pty) |
| Service | Linux: systemd user unit `azito-misao` (`KillMode=process`, `Restart=on-failure`, linger enabled). macOS: launchd `com.azito.misao` (`KeepAlive` with `SuccessfulExit=false`, PATH and LANG set) |
| Templates | `deploy/azito-misao.service` / `deploy/com.azito.misao.plist` (shipped in the release) |

```bash
azito misao status    # service, bundled version, running version, socket
azito misao install   # set up and start (leaves a running daemon alone; safe to repeat)
azito misao update    # switch to the bundled version. Stops the daemon, so every running pane ends (asks first; --yes skips)
azito misao start     # start an installed service that is stopped

systemctl --user status azito-misao       # Linux
journalctl --user -u azito-misao -f
azito misao status                        # macOS (the status line shows the launchd domain)
launchctl print user/$UID/com.azito.misao  # macOS
```

- **Fresh install**: `install.sh` sets it up, starts it and writes `MISAO_SOCKET` to `.env` (with `--no-service` it installs nothing; run `azito misao install` later).
  The local server of a new database defaults to **misao**.
- **Existing installs**: updating the hub does not install misao. Run `azito misao install`, or use "Install misao" on the misao row under
  Servers → your server → Setup. It edits `.env`, so restart the hub afterwards (`systemctl --user restart azito`; panes are not affected).
  If `MISAO_SOCKET` in `.env` points at another daemon, it stops without changing anything by default; pass `azito misao install --replace-socket`
  to replace it on purpose (the UI asks in a dialog).
- **Hub updates**: updating the hub neither updates nor restarts misao (`misao/current` is not switched by a hub update). When the running
  version differs from the bundled one, or the protocol does not match, the Setup row says so and offers an update button.
  Updating is an explicit user action, for when you do not need the panes.
- A source checkout (`npm run dev`) installs no service. It connects to the misao at `MISAO_SOCKET` (or `~/.misao/misao.sock`).

## Updates

Updates are performed from the UI (Settings → System → Check for updates). There is no `azito update` CLI command.

`install.sh` is for initial setup only. It exits without action if AZITO is already installed.

The in-app updater has limits:

| Situation | Behaviour |
|---|---|
| Running under systemd (Linux) | Can update |
| Running under launchd (macOS) | Can update |
| Running under the Task Scheduler (Windows) | Can update ([In-app update of a Windows hub](#in-app-update-of-a-windows-hub)) |
| Started without a service manager | Not supported — switch by hand |
| Pre-releases (`v*-rc*`) | Included when you switch to the rc channel (see below) |

To switch by hand, run steps 1–4 of "Manual install (tarball)" and restart the service. The misao service is not restarted (use `azito misao update` to update it). `~/.azito/hub/.env` and your data live outside the versioned directory, so they carry over untouched.

### Notes when updating (v0.12.0)

- If the hub runs with `AZITO_HARNESS_PREFIX`, from v0.12.0 the worker's prompt uses `~/.azito/harness-<prefix>/bin/azitoctl` (`azitoctl.mjs` on Windows). On an agent / SSH server that has the harness only in the unprefixed `~/.azito/harness`, running a phase fails at once with the reason that this hub's harness (prefix `<prefix>`) is not installed on the server and must be installed again from Setup.
- Fix: after updating, install the harness again from each server's Setup (or `POST /api/servers/:name/harness/install`) with this hub.
- A hub that does not use a prefix (the default) needs nothing.

### Update Channels

AZITO has two update channels:

| Channel | Description |
|---|---|
| `stable` (default) | Tracks stable releases only. Uses GitHub's "latest" release |
| `rc` | Tracks all releases including pre-releases. Shows the newest by SemVer |

Switch via Settings → System → "Development versions" toggle. When `rc` is active, a version list appears and you can install any specific version.

In the `rc` channel, an rc older than your current stable version is never offered as an update (only versions newer than the current one are shown).

### Pre-release naming

```
Stable:       v0.4.0
Pre-release:  v0.4.0-rc.1, v0.4.0-rc.2, …
```

Tags follow SemVer 2.0 pre-release identifiers with dot-separated numeric parts (`-rc.N`).

### rc creation and promotion rules

| Item | Rule |
|---|---|
| Starting point | Issue `-rc.1` once the next stable version's content is ready |
| Changes during rc | Fixes only. New features require bumping the stable version |
| Numbering | Increment `-rc.N` monotonically for each fix |
| Promotion to stable | Tag the same commit as the last rc with the stable version |
| GitHub treatment | Tags containing a hyphen are published as pre-releases |

## Agent Server Auto-Update

On hub startup, all registered Agent servers are automatically version-checked. Updates are determined by a content hash (SHA256 of the bundle file).

| State | Behavior |
|---|---|
| Hash mismatch | Auto-redeploy (build → SSH transfer → restart) |
| Running tasks present | Deferred — rechecked on next hub startup |
| Hash match | No action (`up_to_date`) |

To update manually, use Servers → target server → Setup → Agent Server → "Reinstall".

## Adding a Windows host as an agent

Servers → Add → Agent adds a Windows host over SSH as an agent server (install, the firewall rule, misao, update, removal, the table of what works, limits and troubleshooting). The steps and the specification are in [Windows agent servers](./windows-agent.md); what to prepare on the Windows host is [Prepare](./windows-agent.md#prepare) on that page.

A Windows agent is also updated automatically when the hub starts and its version differs (the same test as in [Agent Server Auto-Update](#agent-server-auto-update); the steps are in [Update](./windows-agent.md#update)).

## Rollback

```bash
# List available versions
ls ~/.azito/hub/

# Switch to a previous version
ln -sfn ~/.azito/hub/v0.3.0 ~/.azito/hub/current

# Restart the service
systemctl --user restart azito  # Linux
# or
launchctl kickstart -k "gui/$(id -u)/com.azito.hub" || launchctl kickstart -k "user/$(id -u)/com.azito.hub"    # macOS
```

On a Windows hub, rewrite `current.txt` and run `azito service restart` ([going back by hand](#troubleshooting-a-windows-hub-update)).

## CLI Commands

`install.sh` places a CLI wrapper at `~/.local/bin/azito`.

```bash
azito start          # Start (Linux: foreground. macOS: starts the launchd service, in the domain it belongs to)
azito stop           # Stop the service
azito status         # Check service status
azito token show     # Show UI token
azito token rotate   # Regenerate UI token
azito misao status   # misao service state (install / update / start take the same form)
azito service status # the hub's own service (start / stop / restart / reload take the same form; macOS also shows the launchd domain)
azito version        # Show version
```

> **Note:** The `azito` CLI is only available in release installs (deployed via `install.sh`). Source checkouts (`git clone` + `npm run dev`) have no CLI wrapper — check the token directly in `packages/server/.env` or `data/ui-token`.

## Supported Platforms

| OS | Architecture | Status |
|----|-------------|--------|
| Linux | x86_64 (x64) | Supported |
| Linux | aarch64 (arm64) | Supported |
| macOS | Apple Silicon (arm64) | Supported |
| macOS | Intel (x64) | Not supported (will consider on demand) |
| Windows | x64 | Supported, as a hub ([Windows bundle](#windows-bundle)) and as an agent server ([Windows agent servers](./windows-agent.md)) |
| Windows | arm64 | Not supported |

## Repository Migration

After OSS migration, the distribution repository may change to `wireframeslayout/azito`.

To specify the repository at build time:

```bash
npm run build:hub -- --repo wireframeslayout/azito
# or
AZITO_RELEASE_REPO=wireframeslayout/azito npm run build:hub
```

## Manual Update on macOS (Fallback)

macOS (launchd) supports in-app updates from Settings → System (restarts via `launchctl kickstart`, in the domain the service is loaded into). The steps below serve as a fallback when the in-app updater is not available.

```bash
# 1. Check the latest version
REPO="wireframeslayout/azito"  # distribution repository
LATEST=$(curl --proto '=https' --tlsv1.2 -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep tag_name | cut -d '"' -f 4)
echo "Latest: $LATEST"

# 2. Download tarball and SHA256SUMS
# Only Apple Silicon (arm64) builds are published; Intel Macs are unsupported.
if [ "$(uname -m)" != "arm64" ]; then
  echo "No build is published for Intel Macs (x86_64)" >&2; exit 1
fi
TARBALL="azito-hub-${LATEST}-darwin-arm64.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/$REPO/releases/download/$LATEST/$TARBALL"
curl --proto '=https' --tlsv1.2 -fsSLO "https://github.com/$REPO/releases/download/$LATEST/SHA256SUMS"

# 3. Verify SHA256
shasum -a 256 -c SHA256SUMS --ignore-missing

# 4. Extract
mkdir -p ~/.azito/hub/"$LATEST"
tar xzf "$TARBALL" -C ~/.azito/hub/"$LATEST" --no-same-owner --no-same-permissions

# 5. Smoke test
~/.azito/hub/"$LATEST"/node ~/.azito/hub/"$LATEST"/azito-hub.cjs --version

# 6. Switch current symlink
ln -sfn ~/.azito/hub/"$LATEST" ~/.azito/hub/current

# 7. Restart the service
launchctl kickstart -k "gui/$(id -u)/com.azito.hub" || launchctl kickstart -k "user/$(id -u)/com.azito.hub"

# 8. Health check
sleep 3 && curl -s http://localhost:3001/api/health | grep version

# 9. Cleanup
rm -f "$TARBALL" SHA256SUMS
```

If the update fails, revert to the previous version:

```bash
# Restore the old version symlink
ls ~/.azito/hub/  # list existing versions
ln -sfn ~/.azito/hub/<old-version> ~/.azito/hub/current
launchctl kickstart -k "gui/$(id -u)/com.azito.hub" || launchctl kickstart -k "user/$(id -u)/com.azito.hub"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tailscale URL refuses the connection | AZITO listens on `127.0.0.1` only | Set `AZITO_BIND=<tailscale-ip>` (from `tailscale ip -4`) in `~/.azito/hub/.env` and restart, or run `tailscale serve --bg 3001` and leave `AZITO_BIND` at its default |
| It connects but the page is blank / terminals drop | The origin is missing from `AZITO_ALLOWED_ORIGINS` | Add the origin you are browsing to and restart |


### "Cannot connect to misao"

```bash
azito misao status                    # is the service running, and how it differs from the bundled version
systemctl --user status azito-misao   # Linux (macOS: `azito misao status` shows the domain; `launchctl print <gui|user>/$UID/com.azito.misao`)
```

If it is stopped run `azito misao start`; if it is not installed run `azito misao install`. When `azito misao status` says to restart the hub,
`MISAO_SOCKET` in the hub's `.env` differs from the socket the running hub uses. Restart the hub.

### "Node.js not found"

The release bundle includes Node.js. `run.sh` uses the bundled `./node`, so you don't need Node.js installed on the host.

### "AZITO_UI_TOKEN is not set"

```bash
azito token show
# or
grep AZITO_UI_TOKEN ~/.azito/hub/.env
```

### "Port 3001 already in use"

```bash
ss -ltn | grep :3001
# Stop any dev server running on that port
```
