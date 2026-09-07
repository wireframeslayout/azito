import { EventEmitter } from 'events';
import { createConnection, type Socket } from 'net';

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export class HerdrEventSubscriber extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private stopped = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionId: number | null = null;

  constructor(
    private socketPath: string,
    private events: string[],
  ) {
    super();
  }

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
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = '';
    this.subscriptionId = null;
  }

  private connect(): void {
    if (this.stopped) return;

    const sock = createConnection(this.socketPath);
    this.socket = sock;

    sock.once('connect', () => {
      this.retryCount = 0;
      this.subscribe(sock);
    });

    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    sock.on('close', () => {
      this.socket = null;
      this.buffer = '';
      this.subscriptionId = null;
      if (!this.stopped) this.scheduleReconnect();
    });

    sock.on('error', () => {
      // close will follow
    });
  }

  private subscribe(sock: Socket): void {
    const id = 1;
    this.subscriptionId = id;
    const req = JSON.stringify({
      id,
      method: 'events.subscribe',
      params: { events: this.events },
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
        const msg = JSON.parse(line);
        if (msg.id === this.subscriptionId && msg.result !== undefined) {
          // subscription ack — ignore
          continue;
        }
        if (msg.event) {
          this.emit('event', { event: msg.event, data: msg.data ?? {} } as HerdrEvent);
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
