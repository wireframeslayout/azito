import type { MuxDriverKind } from '@azito/shared';
import type { ServerConfig } from './Server';

/** A server as far as its mux kinds are concerned. */
export type MuxKindServer = Pick<ServerConfig, 'type' | 'defaultMux'>;

/**
 * The mux kinds a server can host, whatever the state of their daemons: tmux on every server, misao on local servers
 * only (an agent server's misao is not supported). The server's default kind comes first. Which of them answer right
 * now is the registry's business (`MuxDriverRegistry.usableKinds` / `downKinds`).
 */
export function supportedMuxKinds(server: MuxKindServer): MuxDriverKind[] {
  const others: MuxDriverKind[] = server.defaultMux === 'tmux' ? ['misao'] : ['tmux'];
  const supported = [server.defaultMux, ...others];
  return supported.filter((kind) => kind === 'tmux' || server.type === 'local');
}

export function serverSupportsMux(server: MuxKindServer, kind: MuxDriverKind): boolean {
  return supportedMuxKinds(server).includes(kind);
}

/** The servers that can host `kind` (one server can be in both the tmux and the misao selection). Order is kept. */
export function selectServersSupportingMux<T extends MuxKindServer>(servers: T[], kind: MuxDriverKind): T[] {
  return servers.filter((server) => serverSupportsMux(server, kind));
}
