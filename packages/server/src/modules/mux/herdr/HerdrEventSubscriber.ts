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

  /**
   * Grow the subscription set. herdr 0.8.2 accepts exactly one `events.subscribe` per
   * connection — a second request on an open stream resets the socket (observed on
   * server007). So the merged list is applied by reconnecting (debounced so a burst of
   * pane.created events yields one reconnect); the fresh stream replays `tab.created`
   * for existing tabs, which keeps the caller's pane cache consistent.
   */
  addSubscriptions(subs: HerdrSubscription[]): void {
    const key = (x: HerdrSubscription) => `${x.type}\u0000${(x as { pane_id?: string }).pane_id ?? ''}`;
    const have = new Set(this.subscriptions.map(key));
    let changed = false;
    for (const x of subs) {
      if (!have.has(key(x))) { this.subscriptions.push(x); have.add(key(x)); changed = true; }
    }
    if (changed) this.scheduleResubscribe();
  }

  /** Drop subscriptions for a pane that went away; applied lazily on the next reconnect. */
  removePaneSubscriptions(paneId: string): void {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((x) => (x as { pane_id?: string }).pane_id !== paneId);
    if (this.subscriptions.length !== before) this.scheduleResubscribe();
  }

  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleResubscribe(): void {
    if (this.stopped || !this.socket) return; // not started yet: connect() will send the full list
    if (this.resubscribeTimer) return;
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (this.stopped) return;
      this._connected = false;
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = null;
      }
      this.buffer = '';
      this.connect();
    }, 150);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this._connected = false;
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
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
        const normalised = normaliseHerdrEventLine(msg);
        if (normalised) this.emit('event', normalised);
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

const HERDR_EVENT_PREFIXES = ['workspace', 'tab', 'pane', 'worktree', 'layout'] as const;

/** `tab_created` → `tab.created`, `pane_agent_status_changed` → `pane.agent_status_changed`. */
export function herdrEventTypeToDotted(name: string): string {
  if (name.includes('.')) return name;
  for (const prefix of HERDR_EVENT_PREFIXES) {
    if (name.startsWith(prefix + '_')) return prefix + '.' + name.slice(prefix.length + 1);
  }
  return name;
}

/**
 * herdr 0.8.2 streams subscription events as `{"event":"tab_created","data":{"type":"tab_created",...}}`
 * (underscore names, payload under `data`); the request ack is `{"id":..,"result":{"type":"subscription_started"}}`
 * and errors are `{"id":..,"error":{...}}`. Returns the flattened event with a dotted `type`
 * (the vocabulary used by subscriptions and consumers), or null for acks / errors / noise.
 */
export function normaliseHerdrEventLine(msg: Record<string, unknown>): HerdrEvent | null {
  if (msg && typeof msg === 'object' && 'event' in msg) {
    const data = (msg.data && typeof msg.data === 'object') ? (msg.data as Record<string, unknown>) : {};
    const raw = typeof data.type === 'string' ? data.type : String(msg.event);
    return { ...data, type: herdrEventTypeToDotted(raw) } as HerdrEvent;
  }
  if (msg && typeof msg === 'object' && 'result' in msg) return null; // request ack
  if (msg && typeof msg === 'object' && 'error' in msg) return null;
  // Legacy / mock ack shapes: `{ id, type: 'subscribed' | 'ok' | 'subscription_started' }`.
  if (msg && 'id' in msg && (msg.type === 'subscribed' || msg.type === 'ok' || msg.type === 'subscription_started')) return null;
  if (msg && typeof msg.type === 'string') {
    return { ...msg, type: herdrEventTypeToDotted(msg.type as string) } as HerdrEvent;
  }
  return null;
}
