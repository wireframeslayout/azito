import type { MuxDriverKind } from '@azito/shared';
import type { ServerConfig } from './Server';

/** A server as far as its mux kinds are concerned. */
export type MuxKindServer = Pick<ServerConfig, 'type' | 'defaultMux'>;

/**
 * The mux kinds a server can host, whatever the state of their daemons: both, on a local and on an agent server (the
 * agent's misao is reached through its relay). The server's default kind comes first. Which of them are listed and
 * which answer right now is the registry's business (`MuxDriverRegistry.supportedKinds` / `usableKinds` / `downKinds`):
 * a misao that was never set up on an agent is not listed there.
 */
export function supportedMuxKinds(server: MuxKindServer): MuxDriverKind[] {
  return [server.defaultMux, server.defaultMux === 'tmux' ? 'misao' : 'tmux'];
}

export function serverSupportsMux(server: MuxKindServer, kind: MuxDriverKind): boolean {
  return supportedMuxKinds(server).includes(kind);
}
