import WebSocket from 'ws';
import { BasePaneStream } from '../../tmux/PaneOutputStream';
import type { AgentTransport } from './AgentTransport';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { AgentOutdatedError } from './agentPaneStreamProtocol';

export class AgentPaneStream extends BasePaneStream {
  protected filePath: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private failed = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    paneId: string,
    private transport: AgentTransport,
    private wsBaseUrl: string,
    private authHeader: string,
  ) {
    super();
    this.filePath = TaskTempFiles.remotePipeFile(paneId, Date.now());
  }

  start(): void {
    this.registerAndConnect().catch((err) => this.fail(err as Error));
  }

  /**
   * The stream can deliver nothing more (the agent is too old, or it stayed unreachable). Reported as 'stream_failed', not
   * 'error': nothing may take the process down, and the owner of the task decides to fail just that task.
   */
  private fail(err: Error): void {
    if (this.stopped || this.failed) return;
    this.failed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.emit('stream_failed', err);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.transport.releasePaneStreamFile(this.filePath).catch(() => {});
  }

  /**
   * The agent serves only files it manages, so every attempt registers the file first (idempotent: it is not truncated), which
   * also covers an agent restart between reconnects. A failure (an older agent without the endpoint, an unreachable agent)
   * is retried like a lost connection and ends in the reconnection-limit error.
   */
  private async registerAndConnect(): Promise<void> {
    try {
      await this.transport.registerPaneStreamFile(this.filePath);
    } catch (err) {
      // An agent without the endpoint stays without it: retrying cannot help.
      if (err instanceof AgentOutdatedError) this.fail(err);
      else if (!this.stopped) this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      // stop() ran while the registration was in flight: its release came first, so release again.
      this.transport.releasePaneStreamFile(this.filePath).catch(() => {});
      return;
    }
    this.connectWs();
  }

  private connectWs(): void {
    if (this.stopped || this.failed) return;

    const url = `${this.wsBaseUrl}/ws?mode=file-tail&path=${encodeURIComponent(this.filePath)}`;
    const ws = new WebSocket(url, { headers: { authorization: this.authHeader } });
    this.ws = ws;

    ws.on('open', () => {
      this.retryCount = 0;
    });

    ws.on('message', (data: Buffer | string) => {
      if (this.closed) return;
      this.processChunk(data.toString());
    });

    ws.on('close', () => {
      if (this.stopped) return;
      this.scheduleReconnect();
    });

    ws.on('error', () => {
      if (this.stopped) return;
      // close event will follow
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30000);
    if (this.retryCount > 10) {
      this.fail(new Error('AgentPaneStream: reconnection limit reached'));
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.registerAndConnect().catch((err) => this.fail(err as Error));
    }, delay);
  }
}
