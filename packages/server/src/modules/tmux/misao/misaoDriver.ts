import { muxKindForRuntime } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
import type { MuxDriverAvailability, MuxDriverRegistry } from '../MuxDriverRegistry';
import { MisaoConnection, connectDedicatedMisaoClient, type MisaoSdk } from './MisaoConnection';
import { MisaoMuxClient } from './MisaoMuxClient';

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
): MisaoHandle {
  const connection = new MisaoConnection({ socketPath: runtime.socketPath, sdk: runtime.sdk, log });
  const driver = new MisaoMuxClient(connection, { shell: runtime.shell, onChange, log, connectAttachClient: () => connectDedicatedMisaoClient(runtime.sdk, runtime.socketPath) });
  registry.register('misao', driver, (server): MuxDriverAvailability => {
    if (server.type !== undefined && server.type !== 'local') return { available: false, reason: 'remote_unsupported' };
    return connection.availability();
  });
  return { connection, driver };
}
