import path from 'path';

/** sockaddr_un.sun_path on Linux holds 108 bytes including the terminating NUL (same limit as @misao/sdk). */
const MAX_SOCKET_PATH_BYTES = 107;

export const MISAO_SYSTEMD_UNIT = 'azito-misao';
export const MISAO_LAUNCHD_LABEL = 'com.azito.misao';

/**
 * Where the AZITO-managed misao lives. Everything is under `<prefix>/misao/` — deliberately outside `hub/`, so a hub
 * update (which swaps `hub/current`) can never switch or restart the daemon: its panes die when it stops.
 */
export interface MisaoPaths {
  prefix: string;
  /** `<prefix>/misao` — mode 700 (the daemon refuses a more permissive socket directory). */
  root: string;
  /** `<prefix>/misao/current` — symlink to the active `<version>` directory, switched only by an explicit update. */
  current: string;
  /** The daemon's socket; written to the hub's `.env` as MISAO_SOCKET. */
  socket: string;
  log: string;
  /** The hub's stable `.env` (outside the versioned bundle directory). */
  hubEnvFile: string;
}

export function resolveMisaoPaths(prefix: string): MisaoPaths {
  if (!path.isAbsolute(prefix)) throw new Error(`AZITO prefix must be an absolute path: ${prefix}`);
  const root = path.join(prefix, 'misao');
  const socket = path.join(root, 'misao.sock');
  const bytes = Buffer.byteLength(socket);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`The misao socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit of a unix socket: ${socket}. Use a shorter --prefix.`);
  }
  return {
    prefix,
    root,
    current: path.join(root, 'current'),
    socket,
    log: path.join(root, 'misao.log'),
    hubEnvFile: path.join(prefix, 'hub', '.env'),
  };
}

export function versionDir(paths: MisaoPaths, version: string): string {
  return path.join(paths.root, version);
}

/**
 * The install prefix of a release hub: the directory above `hub/` that holds the running bundle
 * (`<prefix>/hub/<version>` or `<prefix>/hub/current`). Null when the hub is not a release install. `AZITO_PREFIX`
 * is not consulted: in a running hub it is the harness hook prefix, not the install location.
 */
export function resolveInstallPrefix(bundleRoot: string | null): string | null {
  if (!bundleRoot) return null;
  const hubDir = path.dirname(bundleRoot);
  return path.basename(hubDir) === 'hub' ? path.dirname(hubDir) : null;
}

/**
 * PATH for the daemon's panes. Neither systemd's user manager nor launchd carries nvm / Homebrew / ~/.local/bin, so
 * the usual locations are listed first, then the PATH of the process doing the install, then the system defaults.
 */
export function buildServicePath(env: NodeJS.ProcessEnv, homeDir: string, exists: (dir: string) => boolean): string {
  const preferred = [
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ].filter(exists);
  const inherited = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const system = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set([...preferred, ...inherited, ...system])].join(path.delimiter);
}
