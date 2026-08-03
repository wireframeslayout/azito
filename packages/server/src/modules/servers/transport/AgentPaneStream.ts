import WebSocket from 'ws';
import { BasePaneStream } from '../../tmux/PaneOutputStream';
import type { AgentTransport } from './AgentTransport';

export class AgentPaneStream extends BasePaneStream {
  protected filePath: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    paneId: string,
    private transport: AgentTransport,
    private wsBaseUrl: string,
    private authHeader: string,
  ) {
    super();
    this.filePath = `/tmp/azito-pipe-${paneId}-${Date.now()}.log`;
  }

  start(): void {
    this.transport.exec(`touch ${this.filePath}`).then(() => {
      this.connectWs();
    }).catch(() => {
      this.connectWs();
    });
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
    this.transport.exec(`rm -f ${this.filePath}`).catch(() => {});
  }

  private connectWs(): void {
    if (this.stopped) return;

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
      this.emit('error', new Error('AgentPaneStream: reconnection limit reached'));
      return;
    }
    this.retryTimer = setTimeout(() => this.connectWs(), delay);
  }
}
