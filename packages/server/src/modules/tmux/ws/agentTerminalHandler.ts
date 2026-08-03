import type { WebSocket } from 'ws';
import { LocalTransport } from '../../servers/transport/LocalTransport';
import type { ITerminalStream } from '../../servers/transport/ServerTransport';
import os from 'os';
import { resolveTmuxRuntime } from '../../servers/transport/TmuxRuntime';
import type { MuxRuntime } from '../../servers/Server';

const PING_INTERVAL_MS = 15_000;

export function handleAgentTerminal(
  ws: WebSocket,
  target: string,
  cols: number,
  rows: number,
  mux?: MuxRuntime,
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

  const muxRuntime = mux ?? (process.env.AZITO_MUX_RUNTIME as MuxRuntime) ?? 'system';
  // Agent process does not receive AZITO_URL from the hub; linked sessions on agents lack hub connectivity (v1 scope-out).
  const hubUrl = process.env.AZITO_URL ?? '';
  const transport = new LocalTransport(resolveTmuxRuntime(muxRuntime, os.homedir()), hubUrl);
  transport
    .openTerminal(target, cols, rows)
    .then((stream) => {
      if (closed) { stream.close(); return; }
      activeStream = stream;

      stream.on('data', (data: string) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });

      stream.on('close', () => {
        if (ws.readyState === ws.OPEN) ws.close();
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
