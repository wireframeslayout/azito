import * as net from 'net';
import { pipeline } from 'stream';
import { createWebSocketStream, type WebSocket } from 'ws';
import { MISAO_RELAY_CLOSE, type AgentMisaoSocket } from '../modules/servers/transport/agentMisaoSocket';

/** The relay hands the daemon's full authority (it runs arbitrary commands) to whoever opens it: bound the fan-out. */
export const MAX_MISAO_RELAYS = 64;

export interface MisaoRelayLog {
  warn(message: string): void;
}

/**
 * Relays a WebSocket to the agent's own misao socket, byte for byte (the hub's SDK speaks its protocol through it).
 * Backpressure is the streams': a slow hub stalls reads from the daemon, and the daemon's own flow control reaches
 * its writer, so nothing piles up in memory. The target is `socket.path` only.
 */
export function createMisaoRelay(socket: AgentMisaoSocket | null, log: MisaoRelayLog): (ws: WebSocket) => void {
  let active = 0;
  return (ws) => {
    if (!socket) {
      ws.close(MISAO_RELAY_CLOSE.disabled, 'misao relay disabled');
      return;
    }
    if (active >= MAX_MISAO_RELAYS) {
      ws.close(MISAO_RELAY_CLOSE.busy, 'too many misao relays');
      return;
    }
    active += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active -= 1;
    };

    const upstream = net.connect(socket.path);
    const wsStream = createWebSocketStream(ws);
    // Messages that arrive before the unix connection is up are held by the stream, not dropped.
    upstream.once('connect', () => {
      pipeline(wsStream, upstream, () => undefined);
      pipeline(upstream, wsStream, () => undefined);
    });
    upstream.once('error', (err: NodeJS.ErrnoException) => {
      release();
      if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') log.warn(`[misao-relay] upstream error: ${err.message}`);
      // The close code is how the hub tells "no daemon" from a network failure; destroying the stream first would terminate without it.
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(MISAO_RELAY_CLOSE.daemonUnreachable, 'misao daemon not reachable');
    });
    upstream.once('close', () => {
      release();
      wsStream.destroy();
    });
    ws.once('close', () => {
      release();
      upstream.destroy();
    });
    wsStream.on('error', () => upstream.destroy());
  };
}
