import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type {
  ExecResult,
  IServerTransport,
  IMuxTransport,
  ITerminalStream,
} from './ServerTransport';
import type { IPaneStream } from '../../tmux/PaneStream';
import { AgentPaneStream } from './AgentPaneStream';
import type { MuxRuntime } from '../Server';
import { type MuxRef, type PaneHandle, type PaneOrdinal, type MuxExecRequest, formatMuxRef, tmuxTargetFromMuxRef } from '@azito/shared';

const PING_INTERVAL_MS = 15_000;

class AgentTerminalStream extends EventEmitter implements ITerminalStream {
  closeCode?: number;
  closeReason?: string;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private missedPongs = 0;

  constructor(private ws: WebSocket) {
    super();
    ws.on('message', (data: Buffer | string) => {
      this.emit('data', data.toString());
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.stopHeartbeat();
      this.closeCode = code;
      this.closeReason = reason.toString();
      this.emit('close');
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('pong', () => { this.missedPongs = 0; });
    this.startHeartbeat();
  }

  write(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  close(): void {
    this.stopHeartbeat();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= 2) { this.ws.terminate(); return; }
      this.missedPongs++;
      this.ws.ping();
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
  }
}

export class AgentTransport implements IServerTransport, IMuxTransport {
  private baseUrl: string;
  private wsBaseUrl: string;
  private authHeader: string;
  private useLegacyMuxRoute = false;

  private token: string;

  private muxRuntime: MuxRuntime;

  constructor(host: string, port: number, token: string, muxRuntime: MuxRuntime) {
    this.token = token;
    this.muxRuntime = muxRuntime;
    this.baseUrl = `http://${host}:${port}`;
    this.wsBaseUrl = `ws://${host}:${port}`;
    this.authHeader = `Bearer ${token}`;
  }

  matchesToken(token: string): boolean {
    return this.token === token;
  }

  matchesMuxRuntime(runtime: MuxRuntime): boolean {
    return this.muxRuntime === runtime;
  }

  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    return this.post('/api/exec', { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  }

  async execMux(req: MuxExecRequest): Promise<ExecResult> {
    if (!this.useLegacyMuxRoute) {
      try {
        const body = req.kind === 'tmux'
          ? { ...req, mux: this.muxRuntime }
          : req;
        return await this.post('/api/mux', body as Record<string, unknown>);
      } catch (err) {
        if (req.kind === 'tmux' && (err as Error).message.includes('failed (404)')) {
          this.useLegacyMuxRoute = true;
          return this.post('/api/tmux', { args: req.args, mux: this.muxRuntime });
        }
        throw err;
      }
    }
    if (req.kind !== 'tmux') throw new Error(`Legacy agent does not support mux kind "${req.kind}"`);
    return this.post('/api/tmux', { args: req.args, mux: this.muxRuntime });
  }

  openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: import('./ServerTransport').OpenTerminalOpts): Promise<ITerminalStream> {
    const target = tmuxTargetFromMuxRef(ref);
    const refParam = `&ref=${encodeURIComponent(formatMuxRef(ref))}&pane=${ordinal}`;
    const herdrLockParam = opts?.herdrLock ? `&herdrLock=${opts.herdrLock}` : '';
    return new Promise((resolve, reject) => {
      const url = `${this.wsBaseUrl}/ws?mode=terminal&target=${encodeURIComponent(target)}${refParam}&cols=${cols}&rows=${rows}&mux=${this.muxRuntime}${herdrLockParam}`;
      const ws = new WebSocket(url, { headers: { authorization: this.authHeader } });

      const timer = setTimeout(() => {
        ws.removeAllListeners();
        ws.terminate();
        reject(new Error('openTerminal timed out'));
      }, 15_000);

      const onError = (err: Error) => { clearTimeout(timer); reject(err); };
      ws.on('error', onError);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.removeListener('error', onError);
        resolve(new AgentTerminalStream(ws));
      });
    });
  }

  createPaneStream(handle: PaneHandle): IPaneStream {
    return new AgentPaneStream(handle as string, this, this.wsBaseUrl, this.authHeader);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<ExecResult> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.authHeader,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Agent ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<ExecResult>;
  }
}
