import * as fs from 'fs';
import * as path from 'path';

/** sockaddr_un.sun_path on Linux holds 108 bytes including the terminating NUL (same limit as @misao/sdk). */
const MAX_SOCKET_PATH_BYTES = 107;

/** WebSocket close codes of the agent's misao relay: the relay could not be served (not a protocol error). */
export const MISAO_RELAY_CLOSE = {
  disabled: 4501,
  daemonUnreachable: 4502,
  busy: 4503,
} as const;

export interface AgentMisaoSocket {
  /** Absolute path of the daemon's socket on this host. Fixed at startup: nothing a client sends can change it. */
  path: string;
}

/**
 * The one socket this agent relays to: `MISAO_SOCKET` (set in the agent's unit/env by the installer) or the managed
 * default `~/.azito/misao/misao.sock`. Resolved once at startup and never taken from a request. Throws when the
 * setting cannot be a unix socket path, so the caller can refuse to serve the relay instead of guessing.
 */
export function resolveAgentMisaoSocket(env: NodeJS.ProcessEnv, homeDir: string): AgentMisaoSocket {
  const configured = env.MISAO_SOCKET;
  const socketPath = configured !== undefined && configured !== '' ? configured : agentMisaoManagedSocket(homeDir);
  if (!path.isAbsolute(socketPath)) throw new Error(`MISAO_SOCKET must be an absolute path: ${socketPath}`);
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) throw new Error(`MISAO_SOCKET is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit of a unix socket: ${socketPath}`);
  return { path: socketPath };
}

/** What the installer needs to know about the host an agent runs on (reported by the agent itself, never guessed over a shell). */
export interface AgentMisaoHost {
  homeDir: string;
  /** The node that runs the agent: the daemon runs on the same one. */
  nodePath: string;
  /** PATH the daemon's panes should see (see buildServicePath). */
  servicePath: string;
  /** The agent's node-pty, which the daemon shares (its prebuilt native part is not rebuilt for it). */
  nodePtyDir: string | null;
  platform: NodeJS.Platform;
  arch: string;
}

/** `GET /api/misao/status` of an agent. */
export interface MisaoSocketStatus {
  socketPath: string;
  /** A unix socket exists at the path (the daemon may still be down: a stale socket file counts). */
  socketPresent: boolean;
  /** The version `<root>/current` points at, when the managed layout is in place. */
  installedVersion?: string;
  host: AgentMisaoHost;
}

/** The one place an agent server's misao is installed: `<home>/.azito/misao`, whatever `MISAO_SOCKET` says. */
export function agentMisaoRoot(homeDir: string): string {
  return path.join(homeDir, '.azito', 'misao');
}

/** The managed layout's socket: what the installer sets up, and what the agent relays to unless `MISAO_SOCKET` says otherwise. */
export function agentMisaoManagedSocket(homeDir: string): string {
  return path.join(agentMisaoRoot(homeDir), 'misao.sock');
}

/** What is on disk for the misao daemon; asking the daemon itself (`server.info`) is the hub's job over the relay. */
export function readMisaoSocketStatus(socket: AgentMisaoSocket, host: AgentMisaoHost): MisaoSocketStatus {
  let socketPresent = false;
  try {
    socketPresent = fs.statSync(socket.path).isSocket();
  } catch {
    socketPresent = false;
  }
  let installedVersion: string | undefined;
  try {
    installedVersion = path.basename(fs.readlinkSync(path.join(agentMisaoRoot(host.homeDir), 'current')));
  } catch {
    installedVersion = undefined;
  }
  return { socketPath: socket.path, socketPresent, ...(installedVersion ? { installedVersion } : {}), host };
}

