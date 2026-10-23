import os from 'os';
import path from 'path';
import type { ServiceSpec } from '../serviceManager';
import { MISAO_WINDOWS_CURRENT_FILE, windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';
import { resolveRealPath } from '../../../shared/os/realPath';
import { MISAO_WINDOWS_TASK_NAME } from '../../servers/agent-deploy/windowsAgentConfig';

/** sockaddr_un.sun_path on Linux holds 108 bytes including the terminating NUL (same limit as @misao/sdk). */
const MAX_SOCKET_PATH_BYTES = 107;

const UNSAFE_PATH_CHARS = /[\s%&<>"'`\\$]/;

export const MISAO_SYSTEMD_UNIT = 'azito-misao';
export const MISAO_LAUNCHD_LABEL = 'com.azito.misao';

export const MISAO_SERVICE: ServiceSpec = {
  systemdUnit: MISAO_SYSTEMD_UNIT,
  launchdLabel: MISAO_LAUNCHD_LABEL,
  windowsTaskName: MISAO_WINDOWS_TASK_NAME,
  templates: { systemd: 'azito-misao.service', launchd: 'com.azito.misao.plist' },
  duplicateLoadFix: 'Boot both copies out (`launchctl bootout gui/<uid>/com.azito.misao` and `launchctl bootout user/<uid>/com.azito.misao`; this closes every pane misao hosts), then run `azito misao start`.',
};

/**
 * Where the AZITO-managed misao lives. Everything is under `<prefix>/misao/` — deliberately outside `hub/`, so a hub
 * update (which swaps `hub/current`) can never switch or restart the daemon: its panes die when it stops.
 */
export interface MisaoPaths {
  prefix: string;
  /** `<prefix>/misao` — mode 700 (the daemon refuses a more permissive socket directory). */
  root: string;
  /** `<prefix>/misao/current` — symlink to the active `<version>` directory, switched only by an explicit update. On Windows it is a file holding the version (no link there; see `MISAO_WINDOWS_CURRENT_FILE`). */
  current: string;
  /** The daemon's socket; written to the hub's `.env` as MISAO_SOCKET. On Windows its named pipe, the one an agent on the same host uses for the same folder. */
  socket: string;
  log: string;
  /** The hub's stable `.env` (outside the versioned bundle directory). */
  hubEnvFile: string;
}

/** The hub's stable `.env`, beside the versioned bundle directories (the installer creates it; run.sh loads it). */
export function hubEnvFilePath(prefix: string): string {
  return path.join(prefix, 'hub', '.env');
}

/** Present on a Windows host: the account name the daemon's named pipe is made from (as `os.userInfo()` reports it). */
export interface MisaoWindowsUser {
  userName: string;
  /** Puts a folder of THIS host in its real spelling (`resolveRealPath`). Given by the entry point, so the path logic below stays a function of its inputs. */
  resolvePath: (folder: string) => string;
}

/** The Windows user of this process when the host is Windows (undefined elsewhere). Resolved at the entry point, then passed down. */
export function misaoWindowsUserOf(platform: NodeJS.Platform): MisaoWindowsUser | undefined {
  return platform === 'win32' ? { userName: os.userInfo().username, resolvePath: resolveRealPath } : undefined;
}

/**
 * Windows: the prefix is a drive path (`C:\Users\Foo Bar (Work)\.azito`). Spaces, parentheses, `&`, `%` and `!` are all fine: a
 * path with any of them reaches the task through the launcher script, in environment variables (see `misaoTaskArguments`). A
 * quote cannot be in a Windows path, and a line break would break the task definition, so those are refused here, early.
 */
function resolveWindowsMisaoPaths(prefix: string, user: MisaoWindowsUser): MisaoPaths {
  const win32 = path.win32;
  if (!/^[A-Za-z]:[\\/]/.test(prefix)) throw new Error(`AZITO prefix must be an absolute path on a drive (C:\\...): ${prefix}`);
  if (/["\r\n\0]/.test(prefix)) {
    throw new Error(`AZITO prefix must not contain a quote or a line break: ${prefix}`);
  }
  // A drive root keeps its separator (`C:` alone is the drive's current folder, not its root).
  const spelled = win32.normalize(prefix).replace(/(?<=[^\\/:])[\\/]+$/, '');
  // Windows spells one folder many ways (8.3 short names such as RUNNER~1, letter case): the prefix is taken in its real spelling.
  const normalized = user.resolvePath(spelled);
  const root = win32.join(normalized, 'misao');
  return {
    prefix: normalized,
    root,
    current: win32.join(root, MISAO_WINDOWS_CURRENT_FILE),
    socket: windowsMisaoPipe(root, user.userName),
    log: win32.join(root, 'misao.log'),
    hubEnvFile: win32.join(normalized, 'hub', '.env'),
  };
}

/** `windowsUser` is given on a Windows host (see {@link misaoWindowsUserOf}) and undefined elsewhere; the Unix checks are unchanged. */
export function resolveMisaoPaths(prefix: string, windowsUser: MisaoWindowsUser | undefined): MisaoPaths {
  if (windowsUser) return resolveWindowsMisaoPaths(prefix, windowsUser);
  if (!path.isAbsolute(prefix)) throw new Error(`AZITO prefix must be an absolute path: ${prefix}`);
  // The prefix lands in a systemd unit and a launchd plist, where whitespace, %, & < > and quotes would be re-interpreted.
  // Rejecting them is simpler and safer than escaping for two formats.
  if (UNSAFE_PATH_CHARS.test(prefix)) {
    throw new Error(`AZITO prefix must not contain whitespace, %, &, <, >, quotes or backslashes (it is written into the service definition): ${prefix}`);
  }
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
    hubEnvFile: hubEnvFilePath(prefix),
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

/** Where the managed service's definition lives on this host (systemd user unit / launchd agent). */
export function misaoServiceDefinitionPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, '.config', 'systemd', 'user', `${MISAO_SYSTEMD_UNIT}.service`),
    path.join(homeDir, 'Library', 'LaunchAgents', `${MISAO_LAUNCHD_LABEL}.plist`),
  ];
}

/**
 * Whether this host has a misao to rely on: the managed service is defined, or MISAO_SOCKET names a daemon. A brand-new
 * installation only defaults its local server to misao in that case; otherwise it starts on tmux. `windowsTaskDefined` is the
 * Windows counterpart of the unit / plist files: the Task Scheduler task `MISAO_SERVICE.windowsTaskName` is registered
 * (asked of the Task Scheduler by the caller, since that is not a file; false off Windows).
 */
export function hasMisaoToRelyOn(env: NodeJS.ProcessEnv, homeDir: string, exists: (file: string) => boolean, windowsTaskDefined: boolean): boolean {
  return !!env.MISAO_SOCKET || windowsTaskDefined || misaoServiceDefinitionPaths(homeDir).some(exists);
}
