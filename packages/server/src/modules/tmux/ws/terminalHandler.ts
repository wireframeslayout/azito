import type { WebSocket } from 'ws';
import type { ServerConfig } from '../../servers/Server';
import type { ITerminalStream, OpenTerminalOpts } from '../../servers/transport/ServerTransport';
import { TERMINAL_CLOSE, type MuxRef, type PaneOrdinal } from '@azito/shared';
import type { MuxDriverRegistry } from '../MuxDriverRegistry';

const PING_INTERVAL_MS = 15_000;
const OPEN_TERMINAL_TIMEOUT_MS = 30_000;

/** Errors a driver throws from openTerminal to say the pane cannot be attached, mapped to the close code the browser reacts to. */
const OPEN_FAILURE_CLOSE = {
  WINDOW_NOT_FOUND: TERMINAL_CLOSE.windowNotFound,
  PANE_STOPPED: TERMINAL_CLOSE.paneStopped,
  WINDOW_EMPTY: TERMINAL_CLOSE.windowEmpty,
  PANE_CLOSED: TERMINAL_CLOSE.paneClosed,
} as const;

function isOpenFailureKey(message: string): message is keyof typeof OPEN_FAILURE_CLOSE {
  return Object.hasOwn(OPEN_FAILURE_CLOSE, message);
}

export function handleTerminalConnection(
  ws: WebSocket,
  server: ServerConfig,
  ref: MuxRef,
  ordinal: PaneOrdinal,
  cols: number,
  rows: number,
  muxDriverRegistry: MuxDriverRegistry,
  terminalOpts?: OpenTerminalOpts,
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

  // Resolving the driver throws synchronously when it is unavailable; route it through the promise chain so the client gets the error message.
  // The routing driver picks the tmux or misao driver by `ref.kind`.
  const openPromise = Promise.resolve().then(() => muxDriverRegistry.resolve(server).openTerminal(server, ref, ordinal, cols, rows, terminalOpts));

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
      if (isOpenFailureKey(err.message)) {
        const { code, reason } = OPEN_FAILURE_CLOSE[err.message];
        ws.close(code, reason);
      } else {
        ws.send(`\r\n${err.message}\r\n`);
        ws.close();
      }
    });
}
