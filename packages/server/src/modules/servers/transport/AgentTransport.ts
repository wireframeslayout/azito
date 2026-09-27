import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type {
  ExecResult,
  IServerTransport,
  ITerminalStream,
} from './ServerTransport';
import type { IPaneStream } from '../../tmux/PaneStream';
import { AgentPaneStream } from './AgentPaneStream';
import type { MuxRuntime } from '../Server';

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

export class AgentTransport implements IServerTransport {
  private baseUrl: string;
  private wsBaseUrl: string;
  private authHeader: string;

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

  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    return this.post('/api/exec', { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  }

  async execTmux(args: string[]): Promise<ExecResult> {
    return this.post('/api/tmux', { args, mux: this.muxRuntime });
  }

  openTerminal(target: string, cols: number, rows: number): Promise<ITerminalStream> {
    return new Promise((resolve, reject) => {
      const url = `${this.wsBaseUrl}/ws?mode=terminal&target=${encodeURIComponent(target)}&cols=${cols}&rows=${rows}&mux=${this.muxRuntime}`;
      const ws = new WebSocket(url, { headers: { authorization: this.authHeader } });

      const onError = (err: Error) => { clearTimeout(timer); reject(err); };
      const onOpen = () => {
        clearTimeout(timer);
        ws.removeListener('error', onError);
        resolve(new AgentTerminalStream(ws));
      };
      const timer = setTimeout(() => {
        // Issue #239: do NOT removeAllListeners() here. terminate() on a socket
        // that is still CONNECTING makes `ws` emit 'error' ("WebSocket was
        // closed before the connection was established"); with no listener
        // attached that becomes an unhandled 'error' event and kills the hub.
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        ws.on('error', () => { /* swallow the terminate()-induced error */ });
        ws.terminate();
        reject(new Error('openTerminal timed out'));
      }, 15_000);
      ws.on('error', onError);
      ws.on('open', onOpen);
    });
  }

  createPaneStream(paneId: string): IPaneStream {
    return new AgentPaneStream(paneId, this, this.wsBaseUrl, this.authHeader);
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
