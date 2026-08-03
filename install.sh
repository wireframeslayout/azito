#!/bin/bash
set -euo pipefail

# AZITO Hub Installer
# Usage: ./install.sh [--version <tag>] [--prefix <dir>] [--no-service] [--yes]

VERSION=""
PREFIX="$HOME/.azito"
NO_SERVICE=false
YES=false
REPO="wireframeslayout/azito"

usage() {
  cat <<EOF
AZITO Hub Installer

Usage: $0 [OPTIONS]

Options:
  --version <tag>    Version to install (default: latest release)
  --prefix <dir>     Installation prefix (default: ~/.azito)
  --no-service       Skip systemd/launchd service setup
  --yes              Skip confirmation prompts
  -h, --help         Show this help
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  VERSION="$2"; shift 2 ;;
    --prefix)   PREFIX="$2"; shift 2 ;;
    --no-service) NO_SERVICE=true; shift ;;
    --yes)      YES=true; shift ;;
    -h|--help)  usage ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Prompting ──
# Read from /dev/tty rather than stdin: under `curl … | bash` stdin is the
# script itself, so a plain `read` gets EOF and every prompt is silently
# skipped. Without a usable tty (CI, `--yes`) we never block — the caller gets
# the safe default instead.
INTERACTIVE=false
if [ "$YES" != true ] && [ -r /dev/tty ] && [ -t 1 ]; then
  INTERACTIVE=true
fi

# confirm <question> <default: y|n> → 0 when the answer is yes
confirm() {
  local question="$1" default="${2:-y}" ans hint
  if [ "$INTERACTIVE" != true ]; then
    [ "$default" = "y" ]
    return
  fi
  [ "$default" = "y" ] && hint="[Y/n]" || hint="[y/N]"
  printf '%s %s ' "$question" "$hint" > /dev/tty
  read -r ans < /dev/tty || ans=""
  [ -z "$ans" ] && ans="$default"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# install_template <src> <dest> — copy a deploy/ template, substituting
# __AZITO_PREFIX__. The templates ship inside the release bundle so that
# deploy/ stays the only definition of the unit/plist (the installer and the
# manual-install docs both read the same file).
install_template() {
  local src="$1" dest="$2"
  if [ ! -f "$src" ]; then
    echo "ERROR: service template not found: $src" >&2
    echo "The release bundle looks incomplete. Re-download and try again." >&2
    exit 1
  fi
  sed "s|__AZITO_PREFIX__|${PREFIX}|g" "$src" > "$dest"
  echo "Installed $(basename "$dest") from bundled template."
}

# Refuse root
if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: Do not run this installer as root." >&2
  echo "Install as a regular user; the service runs under your account." >&2
  exit 1
fi

# Check for existing installation
if [ -L "${PREFIX}/hub/current" ] || [ -d "${PREFIX}/hub/current" ]; then
  echo "AZITO is already installed at ${PREFIX}/hub/current"
  echo "  Version: $(head -1 "${PREFIX}/hub/current/version.txt" 2>/dev/null || echo unknown)"
  echo ""
  echo "This installer only handles first-time setup. To update:"
  echo "  From the UI:  Settings → System → Check for updates"
  echo "  By hand:      extract the tarball into ${PREFIX}/hub/<version> and"
  echo "                repoint ${PREFIX}/hub/current at it, then restart the service."
  echo "                See docs/install-and-update.md ('Manual install')."
  echo ""
  echo "Note: the in-app updater tracks stable releases only, so pre-releases"
  echo "      (v*-rc*) have to be switched by hand."
  exit 0
fi

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)      echo "ERROR: Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)             echo "ERROR: Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Resolve version
if [ -z "$VERSION" ]; then
  echo "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
  if [ -z "$VERSION" ]; then
    echo "ERROR: Could not determine latest version" >&2
    exit 1
  fi
fi

TARBALL="azito-hub-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}"

echo ""
echo "  AZITO Hub Installer"
echo "  ─────────────────────"
echo "  Version:      ${VERSION}"
echo "  Platform:     ${PLATFORM}-${ARCH}"
echo "  Prefix:       ${PREFIX}"
echo "  Service:      $([ "$NO_SERVICE" = true ] && echo "skip" || echo "auto")"
echo ""

# ── Preflight: host dependencies ──
# Node is bundled, but AZITO drives real tmux sessions and git worktrees on the
# host, so those must exist. Tailscale is optional (remote access + push).
PKG_INSTALL=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_INSTALL="sudo apt-get update && sudo apt-get install -y"
elif command -v dnf >/dev/null 2>&1; then
  PKG_INSTALL="sudo dnf install -y"
elif command -v pacman >/dev/null 2>&1; then
  PKG_INSTALL="sudo pacman -S --noconfirm"
elif command -v brew >/dev/null 2>&1; then
  PKG_INSTALL="brew install"
fi

MISSING_REQUIRED=""
for dep in tmux git; do
  command -v "$dep" >/dev/null 2>&1 || MISSING_REQUIRED="${MISSING_REQUIRED} ${dep}"
done
MISSING_REQUIRED="${MISSING_REQUIRED# }"

if [ -n "$MISSING_REQUIRED" ]; then
  echo ""
  echo "Missing required dependencies: ${MISSING_REQUIRED// /, }"
  echo "  AZITO drives tmux sessions and git worktrees on this host, so these are required."
  # Only ever install packages when a human is there to approve the sudo. A
  # piped or --yes run stops with instructions instead of escalating silently.
  if [ "$INTERACTIVE" = true ] && [ -n "$PKG_INSTALL" ] && confirm "Install them now (uses sudo)?" y; then
    # shellcheck disable=SC2086
    eval "$PKG_INSTALL $MISSING_REQUIRED"
    for dep in $MISSING_REQUIRED; do
      command -v "$dep" >/dev/null 2>&1 || { echo "ERROR: ${dep} is still missing after install." >&2; exit 1; }
    done
    echo "Dependencies installed."
  else
    echo ""
    echo "Install them and re-run this installer. For example:"
    echo "  ${PKG_INSTALL:-<your package manager>} ${MISSING_REQUIRED}"
    exit 1
  fi
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo ""
  echo "Tailscale is not installed (optional)."
  echo "  It is what lets you reach AZITO from other devices and enables push"
  echo "  notifications over HTTPS. Without it AZITO only serves 127.0.0.1."
  if [ "$PLATFORM" = "linux" ] && confirm "Install Tailscale now (runs the official installer with sudo)?" n; then
    curl -fsSL https://tailscale.com/install.sh | sh
    if command -v tailscale >/dev/null 2>&1; then
      echo "Tailscale installed. Run 'sudo tailscale up --ssh' afterwards to join your tailnet."
    else
      echo "WARNING: Tailscale install did not complete; continuing without it." >&2
    fi
  else
    echo "  Skipping. See https://tailscale.com/download to add it later."
  fi
fi

# The bundle ships a Node binary for the hub process itself, but not npm/npx.
# Features that shell out still need Node on the host, so say so up front
# instead of letting the user hit it later in the Setup screen.
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Note: Node.js not found on this host."
  echo "  AZITO itself runs on the bundled Node, so the hub will start fine."
  echo "  Host Node.js (v24+) is still needed for:"
  echo "    - installing the browser runtime (uses npx)"
  echo "    - supervised worker windows (azs runs the supervisor with node)"
  echo "  Install it later with your package manager or nvm if you need those."
fi

for opt in claude codex; do
  command -v "$opt" >/dev/null 2>&1 || echo "Note: '${opt}' CLI not found — required only if you run ${opt} workers."
done

if ! confirm "Proceed with installation?" y; then
  echo "Aborted."
  exit 0
fi

# Download
TMPDIR_INSTALL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

echo "Downloading ${TARBALL}..."
curl -fsSL -o "${TMPDIR_INSTALL}/${TARBALL}" "${DOWNLOAD_URL}/${TARBALL}"
curl -fsSL -o "${TMPDIR_INSTALL}/SHA256SUMS" "${DOWNLOAD_URL}/SHA256SUMS"

# Verify
echo "Verifying SHA256..."
EXPECTED=$(grep "${TARBALL}" "${TMPDIR_INSTALL}/SHA256SUMS" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "ERROR: ${TARBALL} not found in SHA256SUMS" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "${TMPDIR_INSTALL}/${TARBALL}" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "${TMPDIR_INSTALL}/${TARBALL}" | awk '{print $1}')
else
  echo "ERROR: No sha256sum or shasum found" >&2
  exit 1
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "ERROR: SHA256 mismatch" >&2
  echo "  Expected: ${EXPECTED}" >&2
  echo "  Got:      ${ACTUAL}" >&2
  exit 1
fi
echo "SHA256 verified."

# Extract
INSTALL_DIR="${PREFIX}/hub/${VERSION}"
mkdir -p "$INSTALL_DIR"
echo "Extracting to ${INSTALL_DIR}..."
tar xzf "${TMPDIR_INSTALL}/${TARBALL}" -C "$INSTALL_DIR"

# macOS quarantine removal
if [ "$PLATFORM" = "darwin" ]; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
fi

# Symlink current
ln -sfn "$INSTALL_DIR" "${PREFIX}/hub/current"
echo "Symlinked ${PREFIX}/hub/current → ${INSTALL_DIR}"

# Create data directory
DATA_DIR="${PREFIX}/data"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Generate .env in a stable location (not inside versioned directory)
ENV_FILE="${PREFIX}/hub/.env"
if [ ! -f "$ENV_FILE" ]; then
  UI_TOKEN=$(openssl rand -hex 32)

  # AZITO binds to 127.0.0.1 and CORS/WebSocket only accept listed origins.
  # Detect Tailscale so remote access works out of the box: with `tailscale
  # serve` the browser's Origin is the MagicDNS HTTPS name, and without it the
  # user reaches http://<magicdns>:PORT directly. Both are added when present —
  # listing an origin the user does not use is harmless.
  ALLOWED_ORIGINS="http://localhost:3001"
  TS_DNS=""
  TS_IP=""
  BIND_LINE="#AZITO_BIND=127.0.0.1"
  PUBLIC_URL_LINE="# AZITO_PUBLIC_URL=https://your-host.ts.net"
  if command -v tailscale >/dev/null 2>&1; then
    TS_DNS=$(tailscale status --self --json 2>/dev/null \
      | grep -o '"DNSName"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 | sed 's/.*"\([^"]*\)"$/\1/' | sed 's/\.$//')
    TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
  fi

  # AZITO listens on 127.0.0.1 by default. Adding the tailnet origin without
  # also changing the bind address would look like remote access is set up
  # while every connection is refused, so make the choice explicit here.
  if [ -n "$TS_IP" ]; then
    echo ""
    echo "Tailscale detected (${TS_DNS:-$TS_IP})."
    echo "  AZITO listens on 127.0.0.1 only unless you bind it to the tailnet."
    echo "  Binding exposes the port to your tailnet; access still requires the UI token."
    echo "  Alternative: keep 127.0.0.1 and run 'tailscale serve --bg 3001' for HTTPS."
    if confirm "Listen on ${TS_IP} so other devices on your tailnet can connect?" n; then
      BIND_LINE="AZITO_BIND=${TS_IP}"
      PUBLIC_URL_LINE="AZITO_PUBLIC_URL=http://${TS_IP}:3001"
      echo "  Will listen on ${TS_IP}:3001"
    else
      echo "  Keeping 127.0.0.1. Set AZITO_BIND in ${ENV_FILE} later to change this."
      if [ -n "$TS_DNS" ]; then
        PUBLIC_URL_LINE="AZITO_PUBLIC_URL=https://${TS_DNS}"
        echo "  Set AZITO_PUBLIC_URL=https://${TS_DNS} (requires 'tailscale serve --bg 3001')."
      fi
    fi
  fi
  if [ -n "$TS_DNS" ]; then
    ALLOWED_ORIGINS="${ALLOWED_ORIGINS},https://${TS_DNS},http://${TS_DNS}:3001"
  fi

  cat > "$ENV_FILE" <<ENVEOF
AZITO_DATA_DIR=${DATA_DIR}
AZITO_UI_TOKEN=${UI_TOKEN}
PORT=3001
# Origins allowed for CORS and WebSocket. Add entries here when you reach AZITO
# from a new hostname, then restart the service.
AZITO_ALLOWED_ORIGINS=${ALLOWED_ORIGINS}
# Listen address. Keep 127.0.0.1 when a reverse proxy (e.g. tailscale serve)
# terminates TLS and forwards to localhost. Set a Tailscale IP only when you
# connect to this port directly. 0.0.0.0 is rejected.
${BIND_LINE}
# URL that supervisors and remote agents use to reach this hub.
# Must be reachable from tmux panes. When using tailscale serve,
# set this to your MagicDNS HTTPS URL (e.g. https://myhost.ts.net).
${PUBLIC_URL_LINE}
ENVEOF
  chmod 600 "$ENV_FILE"
  if [ -n "$TS_DNS" ]; then
    echo "Detected Tailscale host ${TS_DNS} — added to AZITO_ALLOWED_ORIGINS."
  fi
  echo ""
  echo "  ┌─────────────────────────────────────────────────┐"
  echo "  │  UI Token (save this — shown only once):        │"
  echo "  │                                                 │"
  echo "  │  ${UI_TOKEN}  │"
  echo "  │                                                 │"
  echo "  │  Use this token to authenticate in the browser. │"
  echo "  │  To show again: azito token show                │"
  echo "  └─────────────────────────────────────────────────┘"
  echo ""
else
  echo ".env already exists, skipping token generation."
fi

# Install CLI wrapper
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat > "${BIN_DIR}/azito" <<'WRAPPER'
#!/bin/bash
set -euo pipefail

AZITO_PREFIX="${AZITO_PREFIX:-$HOME/.azito}"
CURRENT="${AZITO_PREFIX}/hub/current"

if [ ! -d "$CURRENT" ]; then
  echo "ERROR: AZITO not found at ${CURRENT}" >&2
  echo "Run install.sh first." >&2
  exit 1
fi

case "${1:-}" in
  start)
    exec "${CURRENT}/run.sh"
    ;;
  stop)
    if [ "$(uname -s)" = "Linux" ]; then
      systemctl --user stop azito 2>/dev/null || echo "Service not running or not installed"
    elif [ "$(uname -s)" = "Darwin" ]; then
      launchctl unload ~/Library/LaunchAgents/com.azito.hub.plist 2>/dev/null || echo "Service not running or not installed"
    fi
    ;;
  status)
    if [ "$(uname -s)" = "Linux" ]; then
      systemctl --user status azito --no-pager 2>/dev/null || echo "Service not installed"
    elif [ "$(uname -s)" = "Darwin" ]; then
      launchctl list | grep com.azito.hub || echo "Service not installed"
    fi
    ;;
  token)
    shift
    exec "${CURRENT}/node" "${CURRENT}/azito-hub.cjs" token "$@"
    ;;
  version)
    if [ -f "${CURRENT}/version.txt" ]; then
      head -1 "${CURRENT}/version.txt"
    else
      echo "dev"
    fi
    ;;
  *)
    echo "Usage: azito {start|stop|status|token show|token rotate|version}"
    ;;
esac
WRAPPER
chmod +x "${BIN_DIR}/azito"
echo "CLI installed at ${BIN_DIR}/azito"

# Check PATH
case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo ""
    echo "WARNING: ${BIN_DIR} is not in your PATH."
    echo "Add it to your shell profile:"
    echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
    echo ""
    ;;
esac

# Service setup
if [ "$NO_SERVICE" = true ]; then
  echo "Skipping service setup (--no-service)."
elif [ "$PLATFORM" = "linux" ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  install_template "${INSTALL_DIR}/deploy/azito-release.service" "${UNIT_DIR}/azito.service"

  loginctl enable-linger "$(whoami)" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable azito
  systemctl --user start azito

  sleep 2
  if curl -sf http://localhost:3001/ >/dev/null 2>&1; then
    echo "AZITO is running at http://localhost:3001/"
  else
    echo "Service started but health check failed. Check logs:"
    echo "  journalctl --user -u azito -f"
  fi

elif [ "$PLATFORM" = "darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"
  install_template "${INSTALL_DIR}/deploy/com.azito.hub.plist" "${PLIST_DIR}/com.azito.hub.plist"

  launchctl load "${PLIST_DIR}/com.azito.hub.plist"
  echo "AZITO launchd service loaded."
  echo "Logs: ${PREFIX}/hub/azito.log"
fi

echo ""
echo "Installation complete!"
echo ""
echo "  Start:   azito start     (or let the service auto-start)"
echo "  Status:  azito status"
echo "  Token:   azito token show"
echo "  Version: azito version"
