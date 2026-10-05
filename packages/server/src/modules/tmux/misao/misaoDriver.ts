import type { MisaoDaemonInfo } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
import type { MuxDriverRegistry } from '../MuxDriverRegistry';
import { MisaoConnection, connectDedicatedMisaoClient, type MisaoSdk } from './MisaoConnection';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { MisaoMuxClient } from './MisaoMuxClient';
import { MisaoServers, type MisaoServersDeps } from './MisaoServers';
import { MisaoDriverRouter } from './MisaoDriverRouter';
import type { HubPaneEnvConfig } from '../hubPaneEnv';

/** Everything the misao driver needs from its environment, resolved once at the composition root. */
export interface MisaoRuntime {
  sdk: MisaoSdk;
  socketPath: string;
  shell: string;
}

export interface MisaoRuntimeInput {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /** Shell panes run when no command is given, and the interpreter for commands (`<shell> -lc <command>`). */
  shell: string;
}

/** Loads the ESM-only SDK and resolves the daemon socket. Does not touch the daemon: it may be absent. */
export async function resolveMisaoRuntime({ env, homeDir, shell }: MisaoRuntimeInput): Promise<MisaoRuntime> {
  const sdk = await import('@misao/sdk');
  return { sdk, socketPath: sdk.resolveSocketPath({ env, homeDir }), shell };
}

/** Socket used when the configured one is unusable: nothing listens there, so the driver reports `daemon_unreachable`. */
const UNUSABLE_SOCKET_PATH = '/nonexistent/misao.sock';

/**
 * `resolveMisaoRuntime` for the composition root. A socket setting the OS cannot bind (relative path, over 107 bytes)
 * must not stop a hub that uses no misao server: it is logged and the driver is left pointing at an unreachable socket.
 * With a misao server registered the error propagates (fail fast), since that server could never work.
 */
export async function resolveMisaoRuntimeForHub(
  input: MisaoRuntimeInput,
  hasMisaoServers: boolean,
  log: { warn(message: string): void },
): Promise<MisaoRuntime> {
  try {
    return await resolveMisaoRuntime(input);
  } catch (err) {
    if (hasMisaoServers) throw err;
    log.warn(`[misao] the misao socket setting is unusable, so the misao driver stays unavailable (daemon_unreachable): ${err instanceof Error ? err.message : String(err)}`);
    const sdk = await import('@misao/sdk');
    return { sdk, socketPath: UNUSABLE_SOCKET_PATH, shell: input.shell };
  }
}

export interface MisaoHandle {
  /** The hub's own daemon connection, shared by every local server. */
  connection: MisaoConnection;
  driver: MisaoMuxClient;
  /** The socket this hub's connection uses (what MISAO_SOCKET / the default resolved to at startup). */
  socketPath: string;
  /** Every misao the hub talks to: the local one above, plus one per agent server that has misao. */
  servers: MisaoServers;
}

export interface MisaoDaemonStatus {
  installed: boolean;
  /** The daemon's protocol version (`server.info`). */
  version?: string;
  /** The daemon's release version (`server.info`); a daemon that predates the field reports none. */
  daemonVersion?: string;
  /** Why the daemon is not usable. */
  detail?: string;
}

/** Reports whether the daemon is reachable and which protocol / release it speaks. Never throws: a failure is the status. */
export async function probeMisaoDaemon(connection: MisaoConnection): Promise<MisaoDaemonInfo> {
  const availability = connection.availability();
  if (!availability.available) return { reachable: false, detail: availability.reason };
  try {
    const info = await connection.request('server.info', {});
    return { reachable: true, protocolVersion: info.protocolVersion, ...(info.version ? { version: info.version } : {}) };
  } catch (err) {
    if (err instanceof MuxDriverUnavailableError) return { reachable: false, detail: err.reason };
    return { reachable: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** `probeMisaoDaemon` in the shape of an install-status row. */
export async function describeMisaoDaemon(connection: MisaoConnection): Promise<MisaoDaemonStatus> {
  const info = await probeMisaoDaemon(connection);
  if (!info.reachable) return { installed: false, detail: info.detail };
  return { installed: true, version: info.protocolVersion, ...(info.version ? { daemonVersion: info.version } : {}) };
}

/** For a process that never opens an agent server's misao (the auth doctor CLI, tests): no agent server ever gets a node. */
export const NO_AGENT_MISAO: MisaoServersDeps['agent'] = {
  target: () => { throw new Error('this process does not open the misao relay of an agent server'); },
  status: async () => ({ socketPresent: false }),
};

/**
 * Creates the local daemon connection, the per-server nodes on top of it, and registers the routing driver as kind 'misao'.
 * No connection is started: the caller starts the local one (so that startup does not wait for the daemon); an agent
 * server's node starts its own when it is created. `agent` says how the SDK reaches an agent server's daemon and what its agent sees on disk.
 */
export function registerMisaoDriver(
  registry: MuxDriverRegistry,
  runtime: MisaoRuntime,
  onChange: (serverName: string) => void,
  log: { warn(message: string): void },
  hubEnv: HubPaneEnvConfig,
  agent: MisaoServersDeps['agent'],
): MisaoHandle {
  const connection = new MisaoConnection({ socketPath: runtime.socketPath, sdk: runtime.sdk, log });
  const driver = new MisaoMuxClient(connection, { shell: runtime.shell, onChange, log, hubEnv, connectAttachClient: () => connectDedicatedMisaoClient(runtime.sdk, { socketPath: runtime.socketPath }) });
  const servers = new MisaoServers({ sdk: runtime.sdk, shell: runtime.shell, hubEnv, onChange, log, local: { connection, driver }, agent });
  registry.register('misao', new MisaoDriverRouter(servers), (server) => servers.availability(server), (server) => servers.hosts(server));
  return { connection, driver, socketPath: runtime.socketPath, servers };
}

/**
 * Keeps misao's per-server state in step with an edit made while the hub runs. A local server's daemon subscription
 * is the hub's own (installed for every local server at startup, whatever its default mux), so only the server type
 * moves it. An agent server's node is bound to the endpoint and token it was created with, so any edit drops it; a
 * server that still uses misao gets a fresh node (`keepAgentNode`), one that does not simply loses it.
 * Failure to install change hooks is not fatal: the subscription is established when the daemon becomes reachable.
 */
export function syncMisaoNodes(
  misao: MisaoHandle,
  previous: ServerConfig,
  next: ServerConfig,
  keepAgentNode: boolean,
  log: { warn(message: string): void },
): void {
  if (previous.type === 'agent') misao.servers.discardAgentNode(previous);
  if (previous.type === 'local' && next.type === 'agent') {
    misao.driver.uninstallChangeHooks(previous).catch((err) => {
      log.warn(`Could not stop change events for ${previous.name}: ${err}`);
    });
  }
  if (next.type === 'agent') {
    if (keepAgentNode) misao.servers.ensureAgentNode(next);
    return;
  }
  if (previous.type === 'agent') {
    misao.driver.installChangeHooks(next).catch((err) => {
      log.warn(`Change events for ${next.name} are not active yet (will start when the misao daemon is reachable): ${err}`);
    });
  }
}
