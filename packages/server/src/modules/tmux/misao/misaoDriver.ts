import type { MisaoDaemonInfo } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
import { serverSupportsMux } from '../../servers/muxKinds';
import type { MuxDriverAvailability, MuxDriverRegistry } from '../MuxDriverRegistry';
import { MisaoConnection, connectDedicatedMisaoClient, type MisaoSdk } from './MisaoConnection';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';
import { MisaoMuxClient } from './MisaoMuxClient';
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
  connection: MisaoConnection;
  driver: MisaoMuxClient;
  /** The socket this hub's connection uses (what MISAO_SOCKET / the default resolved to at startup). */
  socketPath: string;
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

/**
 * Creates the daemon connection and the driver on top of it, and registers the driver as kind 'misao'.
 * The connection is not started: the caller starts it so that startup does not wait for the daemon.
 */
export function registerMisaoDriver(
  registry: MuxDriverRegistry,
  runtime: MisaoRuntime,
  onChange: (serverName: string) => void,
  log: { warn(message: string): void },
  hubEnv: HubPaneEnvConfig,
): MisaoHandle {
  const connection = new MisaoConnection({ socketPath: runtime.socketPath, sdk: runtime.sdk, log });
  const driver = new MisaoMuxClient(connection, { shell: runtime.shell, onChange, log, hubEnv, connectAttachClient: () => connectDedicatedMisaoClient(runtime.sdk, runtime.socketPath) });
  registry.register('misao', driver, (server): MuxDriverAvailability => {
    if (server.type !== undefined && server.type !== 'local') return { available: false, reason: 'remote_unsupported' };
    return connection.availability();
  });
  return { connection, driver, socketPath: runtime.socketPath };
}

/**
 * Keeps the daemon's change-event subscription in step with an edit made while the hub runs (startup installs it
 * for every server that can host misao, i.e. every local server, whatever its default mux). Changing the default
 * mux does not move that; changing the server type does. Failure to install is not fatal: the subscription is
 * established when the daemon becomes reachable.
 */
export function syncMisaoChangeHooks(
  misao: MisaoHandle,
  previous: ServerConfig,
  next: ServerConfig,
  log: { warn(message: string): void },
): void {
  const wasMisao = serverSupportsMux(previous, 'misao');
  const isMisao = serverSupportsMux(next, 'misao');
  if (isMisao && !wasMisao) {
    misao.driver.installChangeHooks(next).catch((err) => {
      log.warn(`Change events for ${next.name} are not active yet (will start when the misao daemon is reachable): ${err}`);
    });
  } else if (wasMisao && !isMisao) {
    misao.driver.uninstallChangeHooks(next).catch((err) => {
      log.warn(`Could not stop change events for ${next.name}: ${err}`);
    });
  }
}
