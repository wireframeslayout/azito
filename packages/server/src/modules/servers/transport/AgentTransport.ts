import { EventEmitter } from 'events';
import WebSocket, { createWebSocketStream } from 'ws';
import type { Duplex } from 'stream';
import type {
  ExecResult,
  IServerTransport,
  IMuxTransport,
  ITerminalStream,
} from './ServerTransport';
import type { IPaneStream } from '../../tmux/PaneStream';
import { AgentPaneStream } from './AgentPaneStream';
import { AgentUnreachableError, type AgentUnreachableReason } from './AgentUnreachableError';
import type { MuxRuntime } from '../Server';
import type { MisaoSocketStatus } from './agentMisaoSocket';
import { type MuxRef, type PaneHandle, type PaneOrdinal, type MuxExecRequest, formatMuxRef, tmuxTargetFromMuxRef } from '@azito/shared';

const PING_INTERVAL_MS = 15_000;
/** How long an agent judged unreachable fails fast before a background /health probe may revive it. */
const CIRCUIT_OPEN_MS = 15_000;
export const HEALTH_TIMEOUT_MS = 3_000;
/** Matches the agent's own default exec timeout (agent/routes.ts); the HTTP deadline is this plus transit slack. */
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;
const HTTP_SLACK_MS = 5_000;
/** One release file over a tailnet link: seconds in practice, with room for a slow one. */
const MISAO_UPLOAD_TIMEOUT_MS = 120_000;

function classifyFetchError(err: unknown): AgentUnreachableReason | null {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (!(err instanceof TypeError)) return null;
  const code = (err.cause as { code?: string } | undefined)?.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  return 'unreachable';
}

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

  // Circuit breaker: epoch ms until which calls fail fast; 0 = closed.
  private unreachableUntil = 0;
  private probe: Promise<unknown> | null = null;
  // Request sequencing (see send()): the last handed-out sequence and the newest sequence whose outcome was applied.
  private nextSeq = 0;
  private appliedSeq = 0;

  constructor(host: string, port: number, token: string, muxRuntime: MuxRuntime, private serverName: string) {
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
    return this.post('/api/exec', { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, timeoutMs);
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
    return new Promise((resolve, reject) => {
      const url = `${this.wsBaseUrl}/ws?mode=terminal&target=${encodeURIComponent(target)}${refParam}&cols=${cols}&rows=${rows}&mux=${this.muxRuntime}`;
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

  createPaneStream(handle: PaneHandle): IPaneStream {
    return new AgentPaneStream(handle as string, this, this.wsBaseUrl, this.authHeader);
  }

  /**
   * Opens the agent's misao relay (`/ws?mode=misao`): a byte pipe to the agent's own misao socket, as a Duplex the SDK
   * can speak its protocol over (`MisaoClient({ connect })`). The agent chooses the socket, never this side. Rejects when
   * the WebSocket cannot be opened; a relay that is up but has no daemon behind it closes right after opening, which the
   * SDK sees as a lost connection.
   */
  connectMisaoRelay(signal: AbortSignal): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const ws = new WebSocket(`${this.wsBaseUrl}/ws?mode=misao`, { headers: { authorization: this.authHeader } });
      const abandon = (): void => {
        ws.removeListener('open', onOpen);
        ws.on('error', () => { /* the terminate()-induced error: nobody is left to hear it */ });
        ws.terminate();
        reject(new Error('aborted'));
      };
      const onError = (err: Error): void => {
        signal.removeEventListener('abort', abandon);
        reject(err);
      };
      const onOpen = (): void => {
        signal.removeEventListener('abort', abandon);
        ws.removeListener('error', onError);
        resolve(createWebSocketStream(ws));
      };
      signal.addEventListener('abort', abandon, { once: true });
      ws.once('error', onError);
      ws.once('open', onOpen);
    });
  }

  /** What is on the agent's disk for misao (`GET /api/misao/status`). Shares the breaker like every agent call. */
  async fetchMisaoStatus(): Promise<MisaoSocketStatus> {
    this.assertCircuitClosed();
    const { status, text } = await this.send('/api/misao/status', { method: 'GET', headers: { authorization: this.authHeader } }, HEALTH_TIMEOUT_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent /api/misao/status failed (${status}): ${text}`);
    return JSON.parse(text) as MisaoSocketStatus;
  }

  /**
   * Puts one release file of misao where the agent stages it (`PUT /api/misao/upload`): `<home>/.azito/misao/<version>.upload/`.
   * The agent decides the location; this side only names the version and which release file it is. Returns what the
   * agent received (size, sha256) so the caller can compare it with the hash it expects.
   */
  async uploadMisaoFile(version: string, name: 'misao.mjs' | 'LICENSES.txt', data: Buffer): Promise<{ name: string; size: number; sha256: string }> {
    this.assertCircuitClosed();
    const query = `version=${encodeURIComponent(version)}&name=${encodeURIComponent(name)}`;
    const { status, text } = await this.send(`/api/misao/upload?${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', authorization: this.authHeader },
      body: new Blob([Uint8Array.from(data)]),
    }, MISAO_UPLOAD_TIMEOUT_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent /api/misao/upload failed (${status}): ${text}`);
    return JSON.parse(text) as { name: string; size: number; sha256: string };
  }

  /** True while the breaker is open (fail-fast window), so callers can skip the network entirely. */
  isCircuitOpen(): boolean {
    return Date.now() < this.unreachableUntil;
  }

  /**
   * GET /health with a short deadline, sharing the breaker. Open: throws `circuit_open` without fetching.
   * Half-open: starts (or joins) the single shared probe and returns its outcome, so a recovered agent is reported
   * online right away. Non-2xx responses mean the agent is reachable but unhealthy and throw a plain Error.
   */
  async fetchHealth(): Promise<unknown> {
    if (this.isCircuitOpen()) throw new AgentUnreachableError(this.serverName, 'circuit_open');
    if (this.unreachableUntil !== 0) return this.ensureProbe();
    return this.requestHealth();
  }

  private async requestHealth(): Promise<unknown> {
    const { status, text } = await this.send('/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent /health failed (${status})`);
    return JSON.parse(text) as unknown;
  }

  /**
   * One HTTP round trip including the body read, so a drop or deadline during body transfer is classified like any
   * other network failure. Each round trip takes a monotonically increasing sequence at start; its outcome (success
   * or failure, whatever the breaker state) updates the breaker only if it is newer than the last applied outcome,
   * so a late result of an older request never overrides a newer one.
   */
  private async send(path: string, init: RequestInit, deadlineMs: number): Promise<{ status: number; text: string }> {
    const seq = ++this.nextSeq;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(deadlineMs) });
      const text = await res.text();
      if (seq > this.appliedSeq) {
        this.appliedSeq = seq;
        this.unreachableUntil = 0;
      }
      return { status: res.status, text };
    } catch (err) {
      const reason = classifyFetchError(err);
      if (!reason) throw err;
      if (seq > this.appliedSeq) {
        this.appliedSeq = seq;
        this.unreachableUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
      throw new AgentUnreachableError(this.serverName, reason);
    }
  }

  /** The single shared half-open /health probe (started on demand, joined by concurrent callers). */
  private ensureProbe(): Promise<unknown> {
    if (!this.probe) {
      this.probe = this.requestHealth().finally(() => { this.probe = null; });
    }
    return this.probe;
  }

  /** Fails fast while the breaker is open; once it expires, the shared probe runs in the background and calls keep failing fast until it closes the breaker. */
  private assertCircuitClosed(): void {
    if (this.unreachableUntil === 0) return;
    if (!this.isCircuitOpen()) this.ensureProbe().catch(() => undefined);
    throw new AgentUnreachableError(this.serverName, 'circuit_open');
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<ExecResult> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.authHeader,
      },
      body: JSON.stringify(body),
    }, (timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + HTTP_SLACK_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent ${path} failed (${status}): ${text}`);
    return JSON.parse(text) as ExecResult;
  }
}
