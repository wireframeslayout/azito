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

`install.ps1` (a release asset, also in the repository root) installs it for the current user with Windows PowerShell 5.1: no administrator rights, no symlinks. It needs `git` on the PATH.

```powershell
# Download install.ps1 and SHA256SUMS from the release page, check install.ps1 against SHA256SUMS, then:
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Version v0.12.0] [-Prefix <dir>] [-Yes] [-NoPath]
```

| Option | Meaning |
|---|---|
| `-Version <tag>` | Release to install (default: the latest release) |
| `-Prefix <dir>` | Installation prefix (default: `%USERPROFILE%\.azito`) |
| `-ZipPath <file>` | Use a local `azito-hub-<tag>-win32-x64.zip` instead of downloading (offline installs). Add `-Sha256Sums <file>` to check it |
| `-Yes` | Skip the confirmation prompt |
| `-NoPath` | Do not add `<prefix>\bin` to the user's PATH |
| `-NoService` | Accepted for parity with `install.sh`; the hub is not registered as a service yet, so this is always the behaviour |

It downloads the zip and `SHA256SUMS`, stops if the checksum does not match, and refuses a zip whose entries would land outside the install folder. Layout:

```
<prefix>\hub\<version>\        the extracted bundle (node.exe, azito-hub.cjs, run.ps1, ...)
<prefix>\hub\current.txt       the installed version, one line (Windows has no `current` symlink)
<prefix>\hub\.env              configuration (outside the version folder, so updates keep it)
<prefix>\data\                 database, keys and tokens
<prefix>\bin\azito.cmd         the CLI
```

`hub\.env` and `data\` are created by the bundled hub itself (`node.exe azito-hub.cjs init-env`), so their access rules (current user only) come from the same code that protects them at run time. Running the installer again reports the existing install and changes nothing; updating by hand means extracting the new zip into `hub\<tag>` and writing the tag into `current.txt` as one ASCII line without a BOM. In Windows PowerShell 5.1 `Set-Content -Encoding UTF8` and `>` add a BOM or write UTF-16, which `azito` refuses; use:

```powershell
[System.IO.File]::WriteAllText("$env:USERPROFILE\.azito\hub\current.txt", 'v0.12.0')
```

`current.txt` is written last, after the CLI and the PATH entry. If an install stopped part-way (a `hub\<tag>` folder without `current.txt`), run the installer again to finish it; `hub\.env` and its token are kept.

The CLI reads `current.txt` and runs the bundled hub:

| Command | Effect |
|---|---|
| `azito start` | Runs the hub in the foreground through `run.ps1` (Ctrl+C stops it) |
| `azito token show` / `token rotate` | The UI token (it is stored in `hub\.env`: `rotate` stops while it is set there, so change `AZITO_UI_TOKEN` in that file instead) |
| `azito version` | The version in `current.txt` and the bundle's own |
| `azito misao ...`, `azito service ...` | Passed to the hub, which refuses them on Windows for now: `service` says the Task Scheduler is not supported yet; `misao` currently stops at a check of the install prefix (it rejects the backslashes of a Windows path) until the hub's own misao lands (B3b) |
| `azito stop` / `azito status` | Exit 1 with the reason: there is no resident service yet |

**Not supported yet (#380):** running the hub as a resident service (Task Scheduler), the hub's own misao, and in-app update/uninstall (#381). Until then the hub runs only while `azito start` is open.

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
| Started without a service manager | Not supported — switch by hand |
| Pre-releases (`v*-rc*`) | Included when you switch to the rc channel (see below) |

To switch by hand, run steps 1–4 of "Manual install (tarball)" and restart the service. The misao service is not restarted (use `azito misao update` to update it). `~/.azito/hub/.env` and your data live outside the versioned directory, so they carry over untouched.

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

Servers → Add → Agent works for a Windows host over SSH. The agent runs, but **misao and tmux are not installed on Windows yet** (#369 A3), so the server has no pane server and the install reports the `unsupported_os` reason for misao beside a successful install. File, git and task features on Windows come with #370 / #371; updating and removing a Windows agent comes with #372 (a Windows agent is reinstalled from the Setup row, which replaces it in place).

Prepare the Windows host:

| Prerequisite | Detail |
|---|---|
| OpenSSH Server | Enabled on the Windows host and reachable from the hub. The default shell may stay **cmd.exe** (PowerShell also works): the hub reads the OS first and then runs its checks as a PowerShell script that behaves the same under both. The SSH user is the user the agent will run as |
| Windows | x64 only, judged by the OS's native architecture (Windows on ARM is refused with the reason, even under x64 emulation). Windows 10 version 1809 (build 17763) or later, Windows Server 2019 or later (for `tar.exe` and `conhost.exe --headless`; checked by the preflight). The edition (10 / 11 / Server) is only displayed, not checked |
| Node.js v24+ | On the PATH of the SSH session |
| Tailscale | Installed and signed in. `tailscale.exe` is also found at `%ProgramFiles%\Tailscale\tailscale.exe` when it is not on the PATH |
| Windows Firewall | Must allow inbound TCP 3002 for `node.exe`, and have no Block rule for it (see step 1 below) |

The OS is detected from one `echo AZITO_OS:%OS%:$?` (it reads no variable, so `set -u` does not matter) whose output differs between sh, cmd.exe and PowerShell; an answer that matches none of them is reported as an error, never guessed.

What the install does (no administrator rights are needed or asked for):

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

**The agent only runs while that user is logged on to Windows** (at the console or over Remote Desktop). After a reboot nothing starts until they log on, and logging off stops the agent. A server that survives logoff needs auto-logon or another service model, which is not offered yet.

Operating it:

| Action | How |
|---|---|
| Restart | The hub restarts the task (`schtasks /End` then `/Run`) when it cannot reach the agent; or "Reinstall" in the Setup row |
| Stop | On the host or in an SSH session: `schtasks /End /TN AzitoAgent`, or "End" in Task Scheduler. The agent follows the `conhost.exe` the task runs and ends within a few seconds of it (an agent started by hand with `node azito-agent.cjs` does not). If Windows hands the parent's process id to another process in that moment, the agent notices within about 30 seconds (it compares the parent's creation time); if it still stays up, stop it from the Setup row (the hub ends it by its `--env-file` argument). It comes back at the next logon; add `schtasks /Change /TN AzitoAgent /DISABLE` to keep it from starting |
| Remove (until #372) | `schtasks /End /TN AzitoAgent`, `schtasks /Delete /TN AzitoAgent /F`, delete `%USERPROFILE%\.azito\agent`, and `Remove-NetFirewallRule -DisplayName "AZITO Agent (TCP 3002)"` if the install added the rule |

To try a second agent beside the real one, set `AZITO_WIN_AGENT_TASK_NAME`, `AZITO_WIN_AGENT_DIR` (a folder under the user's home) and `AZITO_WIN_AGENT_PORT` in the hub's environment. They default to `AzitoAgent`, `.azito\agent` and `3002`. These are for trials only: they are not saved per server, so a hub started without them looks for the default task (the hub logs a line when they are in use). Use them in that temporary hub only.

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
