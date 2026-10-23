import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/** sockaddr_un.sun_path on Linux holds 108 bytes including the terminating NUL (same limit as @misao/sdk). */
const MAX_SOCKET_PATH_BYTES = 107;

/** The prefix of a Windows named pipe's path (the same as `NAMED_PIPE_PREFIX` of @misao/protocol). */
const NAMED_PIPE_PREFIX = '\\\\.\\pipe\\';
/** The longest named pipe path misao accepts (@misao/protocol `MAX_NAMED_PIPE_NAME_LENGTH`). */
const MAX_NAMED_PIPE_LENGTH = 256;
const PIPE_USER_MAX_LENGTH = 32;
const PIPE_HASH_LENGTH = 16;

/** The files of a misao release (one target's archive) and the mode each is installed with. The agent accepts exactly these as uploads. */
export const MISAO_RELEASE_FILES = {
  misao: 0o755,
  LICENSE: 0o644,
  NOTICE: 0o644,
  'THIRD-PARTY-LICENSES.txt': 0o644,
} as const;
export type MisaoReleaseFile = keyof typeof MISAO_RELEASE_FILES;
export const MISAO_RELEASE_FILE_NAMES = Object.keys(MISAO_RELEASE_FILES) as MisaoReleaseFile[];

/**
 * The name a release file has on a host of this OS: `misao` is `misao.exe` on Windows. Everywhere else (the manifest, the
 * upload route's query, the bundle) the logical name stays `misao`.
 */
export function misaoFileNameOn(platform: NodeJS.Platform, name: MisaoReleaseFile): string {
  return name === 'misao' && platform === 'win32' ? 'misao.exe' : name;
}

/** WebSocket close codes of the agent's misao relay: the relay could not be served (not a protocol error). */
export const MISAO_RELAY_CLOSE = {
  disabled: 4501,
  daemonUnreachable: 4502,
  busy: 4503,
} as const;

export interface AgentMisaoSocket {
  /** The daemon's endpoint on this host: a unix socket's absolute path, or a named pipe's path (`\\.\pipe\<name>`) on Windows. Fixed at startup: nothing a client sends can change it. */
  path: string;
}

/** What a Windows agent reports of its host beyond what every agent does (read once at startup from its own environment). */
export interface AgentMisaoWindowsHost {
  /** `%SystemRoot%`: where `conhost.exe`, `cmd.exe`, `schtasks.exe` and `powershell.exe` are. */
  systemRoot: string;
  /** The account name as `os.userInfo()` reports it: it is part of the named pipe's default name. */
  userName: string;
  /** Where misao is installed on this host: `<home>\<AZITO_MISAO_DIR>` (default `.azito\misao`). */
  misaoRoot: string;
}

/**
 * The managed pipe of a Windows host (a pure function of the strings it gets; `misaoRoot` must already be in its real spelling, which
 * the host that owns the folder resolved once at its entry point: see `resolveRealPath`): `\\.\pipe\misao-<user>-<sha256(root, lower case)[0:16]>`, the name @misao/sdk's
 * `resolveSocketPath` gives for `MISAO_DIR=<root>` (a test keeps the two in step), so the `misao` CLI run with that MISAO_DIR
 * reaches the same daemon.
 */
export function windowsMisaoPipe(misaoRoot: string, userName: string): string {
  const user = userName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, PIPE_USER_MAX_LENGTH);
  const hash = crypto.createHash('sha256').update(misaoRoot.toLowerCase()).digest('hex').slice(0, PIPE_HASH_LENGTH);
  return `${NAMED_PIPE_PREFIX}misao-${user}-${hash}`;
}

/** Whether `value` is a usable named pipe path: a name with no separators or control characters, within the length limit. */
export function isWindowsMisaoPipe(value: string): boolean {
  if (!value.startsWith(NAMED_PIPE_PREFIX) || value.length > MAX_NAMED_PIPE_LENGTH) return false;
  const name = value.slice(NAMED_PIPE_PREFIX.length);
  return name !== '' && !/[\u0000-\u001f\\/]/.test(name);
}

/**
 * The one socket this agent relays to: `MISAO_SOCKET` (set in the agent's unit/env by the installer) or the managed
 * default (`~/.azito/misao/misao.sock`; on Windows the managed named pipe). Resolved once at startup and never taken from a
 * request. Throws when the setting cannot be a socket path (a named pipe path on Windows), so the caller can refuse to serve
 * the relay instead of guessing.
 */
export function resolveAgentMisaoSocket(env: NodeJS.ProcessEnv, homeDir: string, windows?: AgentMisaoWindowsHost): AgentMisaoSocket {
  const configured = env.MISAO_SOCKET !== undefined && env.MISAO_SOCKET !== '' ? env.MISAO_SOCKET : undefined;
  if (windows) {
    const pipe = configured ?? windowsMisaoPipe(windows.misaoRoot, windows.userName);
    if (!isWindowsMisaoPipe(pipe)) throw new Error(`MISAO_SOCKET must be a named pipe (${NAMED_PIPE_PREFIX}<name>) on Windows: ${pipe}`);
    return { path: pipe };
  }
  const socketPath = configured ?? agentMisaoManagedSocket(homeDir);
  if (!path.isAbsolute(socketPath)) throw new Error(`MISAO_SOCKET must be an absolute path: ${socketPath}`);
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) throw new Error(`MISAO_SOCKET is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit of a unix socket: ${socketPath}`);
  return { path: socketPath };
}

/** What the installer needs to know about the host an agent runs on (reported by the agent itself, never guessed over a shell). */
export interface AgentMisaoHost {
  homeDir: string;
  /** The node that runs the agent (the installer probes the socket with it; the daemon itself is a native binary). */
  nodePath: string;
  /** PATH the daemon's panes should see (see buildServicePath). */
  servicePath: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Present exactly when `platform` is win32. */
  windows?: AgentMisaoWindowsHost;
}

/** `GET /api/misao/status` of an agent. */
export interface MisaoSocketStatus {
  socketPath: string;
  /** A unix socket exists at the path (the daemon may still be down: a stale socket file counts). On Windows, something accepts a connection on the named pipe: a pipe does not outlive its server, so this is "the daemon is up". */
  socketPresent: boolean;
  /** The version `<root>/current` points at (on Windows the version written in `<root>\current`), when the managed layout is in place. */
  installedVersion?: string;
  host: AgentMisaoHost;
}

/** The one place an agent server's misao is installed: `<home>/.azito/misao`, whatever `MISAO_SOCKET` says (a Windows host: see {@link misaoRootOf}). */
export function agentMisaoRoot(homeDir: string): string {
  return path.join(homeDir, '.azito', 'misao');
}

/** Where misao is installed on the host an agent reports: its own folder on Windows, `<home>/.azito/misao` elsewhere. */
export function misaoRootOf(host: AgentMisaoHost): string {
  if (host.platform !== 'win32') return agentMisaoRoot(host.homeDir);
  if (!host.windows) throw new Error('The agent reports a Windows host without its misao folder: update the agent');
  return host.windows.misaoRoot;
}

/** The file that says which release the Windows task starts: the counterpart of the `current` link (a link needs a privilege on Windows). */
export const MISAO_WINDOWS_CURRENT_FILE = 'current';

/** The managed layout's socket: what the installer sets up, and what the agent relays to unless `MISAO_SOCKET` says otherwise. */
export function agentMisaoManagedSocket(homeDir: string): string {
  return path.join(agentMisaoRoot(homeDir), 'misao.sock');
}

/** The managed endpoint of the host an agent reports: its named pipe on Windows, the socket under the home elsewhere. */
export function managedEndpointOf(host: AgentMisaoHost): string {
  if (host.platform !== 'win32') return agentMisaoManagedSocket(host.homeDir);
  if (!host.windows) throw new Error('The agent reports a Windows host without its misao folder: update the agent');
  return windowsMisaoPipe(host.windows.misaoRoot, host.windows.userName);
}

const VERSION_TEXT = /^\d+\.\d+\.\d+$/;
const PIPE_PROBE_TIMEOUT_MS = 2000;

/** Whether something accepts a connection on the named pipe. */
function probePipe(pipePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(pipePath);
    const done = (up: boolean): void => {
      connection.destroy();
      resolve(up);
    };
    connection.setTimeout(PIPE_PROBE_TIMEOUT_MS, () => done(false));
    connection.once('connect', () => done(true));
    connection.once('error', () => done(false));
  });
}

function readInstalledVersion(host: AgentMisaoHost): string | undefined {
  const root = misaoRootOf(host);
  try {
    if (host.platform === 'win32') {
      const text = fs.readFileSync(path.win32.join(root, MISAO_WINDOWS_CURRENT_FILE), 'utf-8').trim();
      return VERSION_TEXT.test(text) ? text : undefined;
    }
    return path.basename(fs.readlinkSync(path.join(root, 'current')));
  } catch {
    return undefined;
  }
}

/** What is on disk for the misao daemon; asking the daemon itself (`server.info`) is the hub's job over the relay. */
export async function readMisaoSocketStatus(socket: AgentMisaoSocket, host: AgentMisaoHost): Promise<MisaoSocketStatus> {
  let socketPresent = false;
  if (host.platform === 'win32') {
    socketPresent = await probePipe(socket.path);
  } else {
    try {
      socketPresent = fs.statSync(socket.path).isSocket();
    } catch {
      socketPresent = false;
    }
  }
  const installedVersion = readInstalledVersion(host);
  return { socketPath: socket.path, socketPresent, ...(installedVersion ? { installedVersion } : {}), host };
}

/** Where an upload of `version` is staged: next to the final `<root>/<version>` directory, which the installer moves it to. */
export function misaoStagingDir(host: AgentMisaoHost, version: string): string {
  const pathApi = host.platform === 'win32' ? path.win32 : path;
  return pathApi.join(misaoRootOf(host), `${version}.upload`);
}

/**
 * Writes one release file into `<misao folder>/<version>.upload/` (through a `.part` file renamed into place) and nothing
 * else, whatever the caller passes: the agent's upload route and the hub's own install both stage through this.
 */
export function stageMisaoReleaseFile(host: AgentMisaoHost, version: string, name: MisaoReleaseFile, data: Buffer): void {
  const windows = host.platform === 'win32';
  const pathApi = windows ? path.win32 : path;
  const root = misaoRootOf(host);
  // Modes mean nothing on Windows (its folders are protected by the installer's ACL step), and chmod there only toggles read-only.
  fs.mkdirSync(root, { recursive: true, ...(windows ? {} : { mode: 0o700 }) });
  // mkdir's mode is masked by the umask and ignored for an existing directory; the daemon refuses anything but 700.
  if (!windows) fs.chmodSync(root, 0o700);
  const stage = misaoStagingDir(host, version);
  fs.mkdirSync(stage, { recursive: true, ...(windows ? {} : { mode: 0o700 }) });

  const target = pathApi.join(stage, misaoFileNameOn(host.platform, name));
  const partial = `${target}.part`;
  fs.writeFileSync(partial, data, windows ? {} : { mode: MISAO_RELEASE_FILES[name] });
  if (!windows) fs.chmodSync(partial, MISAO_RELEASE_FILES[name]);
  fs.renameSync(partial, target);
}
