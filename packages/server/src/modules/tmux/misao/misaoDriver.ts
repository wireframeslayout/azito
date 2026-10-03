import { muxKindForRuntime } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
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

/** Loads the ESM-only SDK and resolves the daemon socket. Called only when AZITO_EXPERIMENTAL_MISAO is on. */
export async function resolveMisaoRuntime({ env, homeDir, shell }: MisaoRuntimeInput): Promise<MisaoRuntime> {
  const sdk = await import('@misao/sdk');
  return { sdk, socketPath: sdk.resolveSocketPath({ env, homeDir }), shell };
}

export interface MisaoHandle {
  connection: MisaoConnection;
  driver: MisaoMuxClient;
}

export interface MisaoDaemonStatus {
  installed: boolean;
  /** The daemon's protocol version (`server.info`). */
  version?: string;
  /** Why the daemon is not usable. */
  detail?: string;
}

/** Reports whether the daemon is reachable and which protocol version it speaks. Never throws: a failure is the status. */
export async function describeMisaoDaemon(connection: MisaoConnection): Promise<MisaoDaemonStatus> {
  const availability = connection.availability();
  if (!availability.available) return { installed: false, detail: availability.reason };
  try {
    const info = await connection.request('server.info', {});
    return { installed: true, version: info.protocolVersion };
  } catch (err) {
    if (err instanceof MuxDriverUnavailableError) return { installed: false, detail: err.reason };
    return { installed: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Servers the misao driver serves: local servers running the misao mux. */
export function selectLocalMisaoServers<T extends Pick<ServerConfig, 'muxRuntime' | 'type'>>(servers: T[]): T[] {
  return servers.filter((s) => muxKindForRuntime(s.muxRuntime) === 'misao' && s.type === 'local');
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
  return { connection, driver };
}

/**
 * Keeps the daemon's change-event subscription in step with a runtime switch made while the hub runs
 * (startup installs it only for servers already on misao). Failure to install is not fatal: the
 * subscription is established when the daemon becomes reachable.
 */
export function syncMisaoChangeHooks(
  misao: MisaoHandle | undefined,
  previous: ServerConfig,
  next: ServerConfig,
  log: { warn(message: string): void },
): void {
  if (!misao) return;
  const wasMisao = selectLocalMisaoServers([previous]).length > 0;
  const isMisao = selectLocalMisaoServers([next]).length > 0;
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
