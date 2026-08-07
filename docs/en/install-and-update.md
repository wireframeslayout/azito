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
| tmux | **Yes** | AZITO drives tmux sessions on the host. `install.sh` checks whether tmux is present and offers to install it (no version verification). 3.4+ recommended |
| git | **Yes** | Per-task worktrees. Same as above |
| Node.js v24+ | Feature-dependent | Browser runtime install (uses `npx`), supervised windows (`azs` starts the supervisor with `node`). **Not needed for the hub to boot** |
| Tailscale | Optional | Access from other devices, push notifications over HTTPS |
| claude / codex CLI | Optional | Only for the corresponding workers |

The Node.js row under Servers → your server → Setup inspects the *host*, not the bundled runtime. Leaving it uninstalled is fine unless you need the features above.

If it reports Node.js as missing even though the host has it, the service's PATH may be missing your nodenv/nvm shims (fixed in v0.3.0-rc2). On older versions, replace `~/.azito/hub/current/run.sh` with the newer one and restart the service.

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

# 8. Start
~/.azito/hub/current/run.sh
```

> Important: If `AZITO_DATA_DIR` is not set, the default `~/.azito/data` is used in release mode. Data is never stored inside the bundle directory.

## Where configuration lives

**The release install (tarball / install.sh) and the source checkout (`git clone` + `npm run dev`) use different config files.** Editing the wrong one silently does nothing.

| | Release install | Source checkout (dev) |
|---|---|---|
| Config file | `~/.azito/hub/.env` | `packages/server/.env` |
| Data | `~/.azito/data/` | `<repo>/data.db`, `<repo>/data/` |
| Applying changes | `systemctl --user restart azito` (macOS: `launchctl kickstart -k gui/$UID/com.azito.hub`) | `touch packages/server/src/main.ts` (`tsx watch` reloads) |

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

launchctl load ~/Library/LaunchAgents/com.azito.hub.plist
```

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

To switch by hand, run steps 1–4 of "Manual install (tarball)" and restart the service. `~/.azito/hub/.env` and your data live outside the versioned directory, so they carry over untouched.

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

## Rollback

```bash
# List available versions
ls ~/.azito/hub/

# Switch to a previous version
ln -sfn ~/.azito/hub/v0.3.0 ~/.azito/hub/current

# Restart the service
systemctl --user restart azito  # Linux
# or
launchctl unload ~/Library/LaunchAgents/com.azito.hub.plist && \
launchctl load ~/Library/LaunchAgents/com.azito.hub.plist    # macOS
```

## CLI Commands

`install.sh` places a CLI wrapper at `~/.local/bin/azito`.

```bash
azito start          # Start (foreground)
azito stop           # Stop the service
azito status         # Check service status
azito token show     # Show UI token
azito token rotate   # Regenerate UI token
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

macOS (launchd) supports in-app updates from Settings → System (restarts via `launchctl kickstart`). The steps below serve as a fallback when the in-app updater is not available.

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
launchctl kickstart -k "gui/$(id -u)/com.azito.hub"

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
launchctl kickstart -k "gui/$(id -u)/com.azito.hub"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tailscale URL refuses the connection | AZITO listens on `127.0.0.1` only | Set `AZITO_BIND=<tailscale-ip>` (from `tailscale ip -4`) in `~/.azito/hub/.env` and restart, or run `tailscale serve --bg 3001` and leave `AZITO_BIND` at its default |
| It connects but the page is blank / terminals drop | The origin is missing from `AZITO_ALLOWED_ORIGINS` | Add the origin you are browsing to and restart |


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
