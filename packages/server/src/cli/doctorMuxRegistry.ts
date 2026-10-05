import os from 'os';
import { asPaneHandle, parseMuxRef } from '@azito/shared';
import { readEnvValue, resolveServerEnvPath } from '../shared/envFile';
import { getBundleRoot } from '../shared/releaseInfo';
import { MuxDriverRegistry } from '../modules/tmux/MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../modules/tmux/MuxCapabilityError';
import { TmuxClient } from '../modules/tmux/TmuxClient';
import { TransportFactory } from '../modules/servers/transport/TransportFactory';
import { registerMisaoDriver, resolveMisaoRuntimeForHub } from '../modules/tmux/misao/misaoDriver';
import { hubEnvFilePath, resolveInstallPrefix } from '../modules/system/misao/misaoPaths';
import type { ServerConfig } from '../modules/servers/Server';

/** The hub's `.env`: a CLI process does not load it (the service's run.sh does), but MISAO_SOCKET lives there. */
function hubEnvFile(): string {
  const prefix = resolveInstallPrefix(getBundleRoot());
  return prefix ? hubEnvFilePath(prefix) : resolveServerEnvPath();
}

export interface DoctorMux {
  registry: MuxDriverRegistry;
  /** Connects to the misao daemon (once). Never rejects on an absent daemon: its driver then reports `daemon_unreachable`. */
  connectMisao(): Promise<void>;
  /** Drops the daemon connection so the process can exit. */
  close(): void;
}

/**
 * The same tmux + misao drivers the hub registers, for a CLI run that has to look at windows of either mux. Nothing
 * here creates a window or writes to a pane, so the hub-side wiring the drivers normally get (change events, pane
 * environment) is left empty.
 */
export async function openDoctorMux(): Promise<DoctorMux> {
  const registry = new MuxDriverRegistry();
  registry.register('tmux', new TmuxClient(new TransportFactory(''), '', '', '', ''));

  const configuredSocket = process.env.MISAO_SOCKET || readEnvValue(hubEnvFile(), 'MISAO_SOCKET');
  const runtime = await resolveMisaoRuntimeForHub(
    { env: { ...process.env, ...(configuredSocket ? { MISAO_SOCKET: configuredSocket } : {}) }, homeDir: os.homedir(), shell: process.env.SHELL || '/bin/bash' },
    false,
    console,
  );
  const misao = registerMisaoDriver(registry, runtime, () => undefined, console, { publicUrl: '', localUrl: '', webhookToken: '' });
  let connecting: Promise<void> | undefined;
  return {
    registry,
    connectMisao: () => (connecting ??= misao.connection.start()),
    close: () => misao.connection.close(),
  };
}

/**
 * Whether a registered window's pane is still alive, asked of the mux that owns it: tmux by `list-panes`, misao through
 * its daemon. `verified: false` means "could not find out" (driver or daemon unreachable), which is never read as "gone".
 * A misao window counts as alive while any of its panes runs.
 */
export async function probeWindowLiveness(
  mux: DoctorMux,
  server: ServerConfig,
  window: { tmuxTarget: string; muxRef: string | null },
): Promise<{ alive: boolean; verified: boolean }> {
  const ref = window.muxRef ? parseMuxRef(window.muxRef) : null;
  const kind = ref?.kind ?? 'tmux';
  if (kind === 'misao') await mux.connectMisao();
  let driver;
  try {
    driver = mux.registry.resolveKind(kind, server);
  } catch (err) {
    if (err instanceof MuxDriverUnavailableError) return { alive: false, verified: false };
    throw err;
  }
  if (!ref || kind === 'tmux') return driver.probePane(server, asPaneHandle(window.tmuxTarget));

  try {
    if (!(await driver.windowExists(server, ref))) return { alive: false, verified: true };
    const panes = await driver.listPanesByRef(server, ref);
    const probes = await Promise.all(panes.map((pane) => driver.probePane(server, pane.handle)));
    if (probes.some((p) => p.alive)) return { alive: true, verified: true };
    return { alive: false, verified: probes.every((p) => p.verified) };
  } catch {
    return { alive: false, verified: false };
  }
}
