import type { WebSocket } from 'ws';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { ITerminalStream } from '../../servers/transport/ServerTransport';
import { muxRefFromTmuxTarget, type PaneOrdinal } from '@azito/shared';

const PING_INTERVAL_MS = 15_000;
const OPEN_TERMINAL_TIMEOUT_MS = 30_000;

export function handleTerminalConnection(
  ws: WebSocket,
  server: ServerConfig,
  target: string,
  cols: number,
  rows: number,
  transportFactory: TransportFactory,
): void {
  let closed = false;
  let activeStream: ITerminalStream | null = null;
  let missedPongs = 0;

  ws.on('pong', () => { missedPongs = 0; });
  const pingTimer = setInterval(() => {
    if (missedPongs >= 2) { ws.terminate(); return; }
    missedPongs++;
    ws.ping();
  }, PING_INTERVAL_MS);
  pingTimer.unref();

  const cleanup = () => {
    closed = true;
    clearInterval(pingTimer);
    activeStream?.close();
    activeStream = null;
  };

  ws.on('close', cleanup);

  const ref = muxRefFromTmuxTarget(target);
  const openPromise = transportFactory
    .getTransport(server)
    .openTerminal(ref, 1 as PaneOrdinal, cols, rows);

  openPromise.then((stream) => {
    if (closed) stream.close();
  }, () => {});

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('openTerminal timed out')),
      OPEN_TERMINAL_TIMEOUT_MS,
    );
    ws.on('close', () => clearTimeout(timer));
  });

  Promise.race([openPromise, timeoutPromise])
    .then((stream) => {
      if (closed) { stream.close(); return; }
      activeStream = stream;

      stream.on('data', (data: string) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });

      stream.on('close', () => {
        if (ws.readyState !== ws.OPEN) return;
        const code = (stream as any).closeCode;
        if (code >= 4000) {
          ws.close(code, (stream as any).closeReason ?? '');
        } else {
          ws.close();
        }
      });

      ws.on('message', (msg: Buffer | string) => {
        const str = msg.toString();
        try {
          const parsed = JSON.parse(str);
          if (parsed.type === 'resize') {
            stream.resize(parsed.cols, parsed.rows);
            return;
          }
        } catch {
          // not JSON — pass through as raw input
        }
        stream.write(str);
      });
    })
    .catch((err: Error) => {
      if (err.message === 'WINDOW_NOT_FOUND') {
        ws.close(4404, 'window not found');
      } else {
        ws.send(`\r\n${err.message}\r\n`);
        ws.close();
      }
    });
}
