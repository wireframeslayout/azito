import { hostFeatureSupport, type HostPlatformInfo, type MuxDriverKind } from '@azito/shared';
import type { ServerConfig } from './Server';

/** A server as far as its mux kinds are concerned. */
export type MuxKindServer = Pick<ServerConfig, 'type' | 'defaultMux'> & { hostProfile?: HostPlatformInfo | null };

/**
 * Whether the server's host runs tmux at all. Windows has no tmux (`hostFeatureSupport`, the one decision): its tmux is
 * never started, listed, hooked or probed, and every Windows server's windows are misao's. An absent / unrecorded
 * profile is a Unix host.
 */
export function hostRunsTmux(server: { hostProfile?: HostPlatformInfo | null }): boolean {
  return hostFeatureSupport(server.hostProfile, 'tmux').available;
}

/**
 * The mux kinds a server can host, whatever the state of their daemons: both, on a local and on an agent server (the
 * agent's misao is reached through its relay). The server's default kind comes first. Which of them are listed and
 * which answer right now is the registry's business (`MuxDriverRegistry.supportedKinds` / `usableKinds` / `downKinds`):
 * a misao that was never set up on an agent is not listed there.
 */
export function supportedMuxKinds(server: MuxKindServer): MuxDriverKind[] {
  if (!hostRunsTmux(server)) return ['misao'];
  return [server.defaultMux, server.defaultMux === 'tmux' ? 'misao' : 'tmux'];
}

export function serverSupportsMux(server: MuxKindServer, kind: MuxDriverKind): boolean {
  return supportedMuxKinds(server).includes(kind);
}
