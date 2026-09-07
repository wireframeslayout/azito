import { EventEmitter } from 'events';
import { createConnection, type Socket } from 'net';

export interface HerdrEvent {
  type: string;
  [key: string]: unknown;
}

export interface HerdrSubscription {
  type: string;
  pane_id?: string;
  pattern?: string;
  [key: string]: unknown;
}

export class HerdrEventSubscriber extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private stopped = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  constructor(
    private socketPath: string,
    private subscriptions: HerdrSubscription[],
  ) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this._connected = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = '';
  }

  private connect(): void {
    if (this.stopped) return;

    const sock = createConnection(this.socketPath);
    this.socket = sock;

    sock.once('connect', () => {
      this.retryCount = 0;
      this._connected = true;
      this.subscribe(sock);
      this.emit('connected');
    });

    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    sock.on('close', () => {
      this.socket = null;
      this.buffer = '';
      this._connected = false;
      if (!this.stopped) this.scheduleReconnect();
    });

    sock.on('error', () => {
      // close will follow
    });
  }

  private subscribe(sock: Socket): void {
    const req = JSON.stringify({
      id: '1',
      method: 'events.subscribe',
      params: { subscriptions: this.subscriptions },
    }) + '\n';
    sock.write(req);
  }

  private processBuffer(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.id === '1' && (msg.type === 'subscribed' || msg.type === 'ok')) {
          continue;
        }
        if (msg.type && typeof msg.type === 'string') {
          this.emit('event', msg as HerdrEvent);
        }
      } catch {
        // skip malformed
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
