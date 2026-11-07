import WebSocket from 'ws';
import type { NotificationBus } from '../../notifications/NotificationBus';

export class AgentEventStream {
  private ws: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private serverName: string,
    private wsBaseUrl: string,
    private authHeader: string,
    private notificationBus: NotificationBus,
    /** Hub-side session-cache invalidation — called before notifying clients so they refetch fresh data. */
    private onTmuxEvent?: (serverName: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
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
  }

  private connect(): void {
    if (this.stopped) return;

    const url = `${this.wsBaseUrl}/ws?mode=events`;
    const ws = new WebSocket(url, { headers: { authorization: this.authHeader } });
    this.ws = ws;
    const connectTimer = setTimeout(() => ws.terminate(), 15_000);
    connectTimer.unref();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let missedPongs = 0;
    ws.on('pong', () => { missedPongs = 0; });
    ws.on('open', () => {
      clearTimeout(connectTimer);
      heartbeat = setInterval(() => {
        if (missedPongs >= 2) { ws.terminate(); return; }
        missedPongs += 1;
        ws.ping();
      }, 15_000);
      heartbeat.unref();
      this.retryCount = 0;
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'tmux-hook') {
          this.onTmuxEvent?.(this.serverName);
          this.notificationBus.emit({
            type: 'sessions:updated',
            payload: { serverName: this.serverName },
          });
        } else if (msg.type === 'browser-opened') {
          this.notificationBus.emit({
            type: 'browser:opened',
            payload: {
              serverName: this.serverName,
              groupId: msg.groupId,
              tabId: msg.tabId,
              url: msg.url ?? null,
              ...(typeof msg.taskId === 'number' ? { taskId: msg.taskId } : {}),
              ...(typeof msg.label === 'string' ? { label: msg.label } : {}),
            },
          });
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => {
      clearTimeout(connectTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', () => {
      // close event will follow
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
