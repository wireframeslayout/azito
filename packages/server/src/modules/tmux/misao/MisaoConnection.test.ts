import { afterEach, describe, expect, it, vi } from 'vitest';
import { MisaoConnection, type MisaoSdk } from './MisaoConnection';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';

type StateListener = (state: { status: 'connected' } | { status: 'reconnecting'; attempt: number; delayMs: number; cause: Error } | { status: 'closed' }) => void;

class FakeMisaoConnectionError extends Error {}
class FakeProtocolVersionError extends Error {}
class FakeMisaoRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

interface FakeClientControl {
  clients: FakeClient[];
  /** Errors returned by successive connect() calls; once empty, connect succeeds. */
  connectFailures: Error[];
  /** Errors thrown by successive subscribeEvents() calls; once empty, subscribing succeeds. */
  subscribeEventsFailures: Error[];
  /** Throws from subscribeLines when set. */
  subscribeLinesError?: () => never;
}

class FakeClient {
  stateListeners: StateListener[] = [];
  gapListeners: Array<(gap: unknown) => void> = [];
  closed = false;
  connectCalls = 0;
  requests: Array<{ method: string; params: unknown }> = [];
  requestHandler: (method: string, params: unknown) => unknown = () => ({ ok: true });
  constructor(private readonly control: FakeClientControl) {}

  onStateChange(cb: StateListener): () => void { this.stateListeners.push(cb); return () => {}; }
  onGap(cb: (gap: unknown) => void): () => void { this.gapListeners.push(cb); return () => {}; }
  subscriptionErrorListeners: Array<(info: unknown) => void> = [];
  lineHandlers = new Map<string, (line: unknown) => void>();
  onSubscriptionError(cb: (info: unknown) => void): () => void { this.subscriptionErrorListeners.push(cb); return () => {}; }
  lineSubscribes: Array<{ paneId: string; options: unknown }> = [];
  lineUnsubscribes: string[] = [];
  /** Where each line stream stands, as the SDK's live `cursor` would report it. */
  lineCursors = new Map<string, { seq: number; epoch: string }>();
  lineSubscribeFailure: Error | undefined;
  async subscribeLines(paneId: string, handler: (line: unknown) => void, options?: unknown): Promise<{ unsubscribe(): void; readonly cursor: { seq: number; epoch: string } }> {
    this.control.subscribeLinesError?.();
    this.lineSubscribes.push({ paneId, options });
    if (this.lineSubscribeFailure) throw this.lineSubscribeFailure;
    this.lineHandlers.set(paneId, handler);
    const cursors = this.lineCursors;
    return { unsubscribe: () => { this.lineUnsubscribes.push(paneId); }, get cursor() { return cursors.get(paneId) ?? { seq: 0, epoch: 'e' }; } };
  }
  onError(): () => void { return () => {}; }
  async connect(): Promise<void> {
    this.connectCalls += 1;
    const failure = this.control.connectFailures.shift();
    if (failure) throw failure;
    for (const cb of this.stateListeners) cb({ status: 'connected' });
  }
  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.requestHandler(method, params);
  }
  eventHandler: ((event: unknown) => void) | undefined;
  eventSubscribeCalls = 0;
  eventUnsubscribeCalls = 0;
  /** Like the SDK: one events subscription per connection. */
  subscribeEvents = async (handler: (event: unknown) => void): Promise<{ unsubscribe(): void; cursor: { seq: number; epoch: string } }> => {
    this.eventSubscribeCalls += 1;
    const failure = this.control.subscribeEventsFailures.shift();
    if (failure) throw failure;
    if (this.eventHandler) throw new Error('stream already registered: events');
    this.eventHandler = handler;
    return { unsubscribe: () => { this.eventHandler = undefined; this.eventUnsubscribeCalls += 1; }, cursor: { seq: 0, epoch: 'e' } };
  };
  /** An SDK reconnect, in the SDK's order: a refused events restore is reported while restoring, then the state turns connected. */
  reconnect(restore: 'restored' | 'refused'): void {
    for (const cb of this.stateListeners) cb({ status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('lost') });
    if (restore === 'refused') {
      this.eventHandler = undefined;
      for (const cb of this.subscriptionErrorListeners) cb({ stream: { kind: 'events' }, error: new Error('refused') });
    }
    for (const cb of this.stateListeners) cb({ status: 'connected' });
  }
  /** Makes subscribeEvents() resolve only when `release()` is called. */
  holdSubscribeEvents(): { release(): void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = this.subscribeEvents.bind(this);
    this.subscribeEvents = async (handler) => { await held; return original(handler); };
    return { release };
  }
  close(): void { this.closed = true; }
}

/** A stand-in for the ESM-only SDK module: only what MisaoConnection touches. */
function createFakeSdk(): { sdk: MisaoSdk; control: FakeClientControl } {
  const control: FakeClientControl = { clients: [], connectFailures: [], subscribeEventsFailures: [] };
  const sdk = {
    MisaoClient: function MisaoClient() {
      const client = new FakeClient(control);
      control.clients.push(client);
      return client;
    },
    MisaoConnectionError: FakeMisaoConnectionError,
    MisaoProtocolVersionError: FakeProtocolVersionError,
    MisaoRpcError: FakeMisaoRpcError,
    DEFAULT_BACKOFF: { initialDelayMs: 100, maxDelayMs: 5000, factor: 2 },
    computeBackoffDelay: (attempt: number, o: { initialDelayMs: number; maxDelayMs: number; factor: number }) => Math.min(o.maxDelayMs, o.initialDelayMs * o.factor ** (attempt - 1)),
  } as unknown as MisaoSdk;
  return { sdk, control };
}

function setup() {
  const { sdk, control } = createFakeSdk();
  const warn = vi.fn();
  const connection = new MisaoConnection({ socketPath: '/tmp/x.sock', sdk, log: { warn } });
  return { connection, control, warn };
}

afterEach(() => { vi.useRealTimers(); });

describe('MisaoConnection', () => {
  it('is unavailable before start and available once connected', async () => {
    const { connection, control } = setup();
    expect(connection.availability()).toEqual({ available: false, reason: 'daemon_unreachable' });
    await connection.start();
    expect(control.clients[0].connectCalls).toBe(1);
    expect(connection.availability()).toEqual({ available: true });
  });

  it('retries the first connect with backoff until the daemon appears', async () => {
    vi.useFakeTimers();
    const { connection, control, warn } = setup();
    control.connectFailures.push(new FakeMisaoConnectionError('down'), new FakeMisaoConnectionError('down'));
    await connection.start();
    expect(connection.availability()).toEqual({ available: false, reason: 'daemon_unreachable' });
    expect(warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(control.clients[0].connectCalls).toBe(2);
    expect(connection.availability().available).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(control.clients[0].connectCalls).toBe(3);
    expect(connection.availability()).toEqual({ available: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up on a failure that is neither a connection error nor a protocol mismatch', async () => {
    vi.useFakeTimers();
    const { connection, control, warn } = setup();
    control.connectFailures.push(new Error('boom'));
    await connection.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(control.clients[0].connectCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('giving up'));
  });

  it('keeps retrying a protocol mismatch at a capped interval, reports why, and recovers when the daemon is replaced', async () => {
    vi.useFakeTimers();
    const { connection, control, warn } = setup();
    control.connectFailures.push(...Array.from({ length: 8 }, () => new FakeProtocolVersionError('server 2.0, client 1.0')));
    await connection.start();
    expect(connection.availability()).toEqual({ available: false, reason: 'protocol_incompatible' });
    expect(warn).toHaveBeenCalledTimes(1);

    // 1s, 2s, 4s, 8s, 16s, then capped at 30s.
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000);
    expect(control.clients[0].connectCalls).toBe(6);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(control.clients[0].connectCalls).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(control.clients[0].connectCalls).toBe(7);
    expect(connection.availability()).toEqual({ available: false, reason: 'protocol_incompatible' });
    expect(warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(control.clients[0].connectCalls).toBe(8);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(control.clients[0].connectCalls).toBe(9);
    expect(connection.availability()).toEqual({ available: true });
  });

  it('a daemon that turns incompatible after connecting is retried with a new client and the events subscription is re-made', async () => {
    vi.useFakeTimers();
    const { connection, control, warn } = setup();
    const onConnected = vi.fn();
    connection.onConnected(onConnected);
    await connection.start();
    const received = vi.fn();
    await connection.subscribeEvents(received);

    for (const cb of control.clients[0].stateListeners) cb({ status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('lost') });
    for (const cb of control.clients[0].stateListeners) cb({ status: 'closed', cause: new FakeProtocolVersionError('server 2.0, client 1.0') } as never);
    expect(connection.availability()).toEqual({ available: false, reason: 'protocol_incompatible' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('server 2.0'));
    expect(control.clients).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(control.clients[1].connectCalls).toBe(1);
    expect(connection.availability()).toEqual({ available: true });
    expect(onConnected).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.clients[1].eventSubscribeCalls).toBe(1);
    control.clients[1].eventHandler?.({ type: 'pane.created' });
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('close() cancels a pending retry and closes the client', async () => {
    vi.useFakeTimers();
    const { connection, control } = setup();
    control.connectFailures.push(new FakeMisaoConnectionError('down'));
    await connection.start();
    connection.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(control.clients[0].connectCalls).toBe(1);
    expect(control.clients[0].closed).toBe(true);
    expect(connection.availability().available).toBe(false);
  });

  it('turns unavailable while the SDK reconnects and notifies listeners when connected again', async () => {
    const { connection, control } = setup();
    const onConnected = vi.fn();
    connection.onConnected(onConnected);
    await connection.start();
    expect(onConnected).toHaveBeenCalledTimes(1);

    for (const cb of control.clients[0].stateListeners) cb({ status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('lost') });
    expect(connection.availability().available).toBe(false);
    for (const cb of control.clients[0].stateListeners) cb({ status: 'connected' });
    expect(connection.availability()).toEqual({ available: true });
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it('notifies disconnect listeners once per loss, not for each failed reconnect attempt', async () => {
    const { connection, control } = setup();
    const onDisconnected = vi.fn();
    connection.onDisconnected(onDisconnected);
    await connection.start();
    expect(onDisconnected).not.toHaveBeenCalled();

    const reconnecting = { status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('lost') } as const;
    for (const cb of control.clients[0].stateListeners) cb(reconnecting);
    for (const cb of control.clients[0].stateListeners) cb({ ...reconnecting, attempt: 2 });
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    for (const cb of control.clients[0].stateListeners) cb({ status: 'connected' });
    for (const cb of control.clients[0].stateListeners) cb(reconnecting);
    expect(onDisconnected).toHaveBeenCalledTimes(2);
  });

  it('logs the cause when the SDK closes the connection, and starts over with a new client', async () => {
    vi.useFakeTimers();
    const { connection, control, warn } = setup();
    await connection.start();
    for (const cb of control.clients[0].stateListeners) cb({ status: 'closed', cause: new Error('odd failure') } as never);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('odd failure'));
    expect(connection.availability()).toEqual({ available: false, reason: 'daemon_unreachable' });
    await vi.advanceTimersByTimeAsync(100);
    expect(control.clients).toHaveLength(2);
    expect(connection.availability()).toEqual({ available: true });
  });

  it('does not start over once close() was called', async () => {
    const { connection, control } = setup();
    await connection.start();
    connection.close();
    for (const cb of control.clients[0].stateListeners) cb({ status: 'closed' } as never);
    expect(control.clients).toHaveLength(1);
  });

  it('forwards gap notifications registered before and after start', async () => {
    const { connection, control } = setup();
    const early = vi.fn();
    connection.onGap(early);
    await connection.start();
    const late = vi.fn();
    const off = connection.onGap(late);
    const gap = { stream: { kind: 'events' }, reason: 'epoch' };
    for (const cb of control.clients[0].gapListeners) cb(gap);
    expect(early).toHaveBeenCalledWith(gap);
    expect(late).toHaveBeenCalledWith(gap);
    off();
    for (const cb of control.clients[0].gapListeners) cb(gap);
    expect(late).toHaveBeenCalledTimes(1);
  });

  describe('events', () => {
    it('shares one SDK subscription between concurrent handlers and delivers to both', async () => {
      const { connection, control } = setup();
      await connection.start();
      const a = vi.fn();
      const b = vi.fn();
      await Promise.all([connection.subscribeEvents(a), connection.subscribeEvents(b)]);
      expect(control.clients[0].eventSubscribeCalls).toBe(1);
      control.clients[0].eventHandler?.({ type: 'pane.state' });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('keeps the other handler running when one unsubscribes, and releases the SDK subscription after the last', async () => {
      const { connection, control } = setup();
      await connection.start();
      const a = vi.fn();
      const b = vi.fn();
      const subA = await connection.subscribeEvents(a);
      const subB = await connection.subscribeEvents(b);
      subA.unsubscribe();
      control.clients[0].eventHandler?.({ type: 'x' });
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
      expect(control.clients[0].eventUnsubscribeCalls).toBe(0);
      subB.unsubscribe();
      expect(control.clients[0].eventUnsubscribeCalls).toBe(1);
      const c = vi.fn();
      await connection.subscribeEvents(c);
      expect(control.clients[0].eventSubscribeCalls).toBe(2);
    });

    it('keeps delivering to every handler after the SDK reconnects, and a throwing handler does not starve the others', async () => {
      const { connection, control, warn } = setup();
      await connection.start();
      const a = vi.fn(() => { throw new Error('boom'); });
      const b = vi.fn();
      await connection.subscribeEvents(a);
      await connection.subscribeEvents(b);
      for (const cb of control.clients[0].stateListeners) cb({ status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('lost') });
      for (const cb of control.clients[0].stateListeners) cb({ status: 'connected' });
      control.clients[0].eventHandler?.({ type: 'pane.state' });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('registers the same function twice independently', async () => {
      const { connection, control } = setup();
      await connection.start();
      const handler = vi.fn();
      const first = await connection.subscribeEvents(handler);
      await connection.subscribeEvents(handler);
      first.unsubscribe();
      control.clients[0].eventHandler?.({ type: 'x' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(control.clients[0].eventUnsubscribeCalls).toBe(0);
    });

    it('re-subscribes at once when the SDK refuses the restore on reconnect, delivers to every handler, and tells listeners it recovered', async () => {
      vi.useFakeTimers();
      const { connection, control } = setup();
      await connection.start();
      const recovered = vi.fn();
      connection.onEventsRecovered(recovered);
      const a = vi.fn();
      const b = vi.fn();
      await connection.subscribeEvents(a);
      await connection.subscribeEvents(b);
      expect(recovered).not.toHaveBeenCalled();
      control.clients[0].reconnect('refused');
      await vi.advanceTimersByTimeAsync(0);
      expect(control.clients[0].eventSubscribeCalls).toBe(2);
      expect(recovered).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(control.clients[0].eventSubscribeCalls).toBe(2);
      control.clients[0].eventHandler?.({ type: 'pane.state' });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('reaches every recovery listener even if one throws, and leaves the subscription healthy', async () => {
      vi.useFakeTimers();
      const { connection, control, warn } = setup();
      await connection.start();
      const after = vi.fn();
      connection.onEventsRecovered(() => { throw new Error('listener boom'); });
      connection.onEventsRecovered(after);
      const handler = vi.fn();
      await connection.subscribeEvents(handler);
      control.clients[0].reconnect('refused');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(after).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener boom'));
      expect(control.clients[0].eventSubscribeCalls).toBe(2);
      control.clients[0].eventHandler?.({ type: 'x' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not report recovery for a restore the SDK accepted', async () => {
      const { connection, control } = setup();
      await connection.start();
      const recovered = vi.fn();
      connection.onEventsRecovered(recovered);
      await connection.subscribeEvents(vi.fn());
      control.clients[0].reconnect('restored');
      expect(recovered).not.toHaveBeenCalled();
      expect(control.clients[0].eventSubscribeCalls).toBe(1);
    });

    it('retries a refused re-subscribe with backoff until it succeeds, reports recovery once, and stops when the last handler leaves', async () => {
      vi.useFakeTimers();
      const { connection, control } = setup();
      await connection.start();
      const recovered = vi.fn();
      connection.onEventsRecovered(recovered);
      const handler = vi.fn();
      const registration = await connection.subscribeEvents(handler);
      control.subscribeEventsFailures.push(new FakeMisaoRpcError(-32000, 'busy'), new FakeMisaoRpcError(-32000, 'busy'));
      control.clients[0].reconnect('refused');
      await vi.advanceTimersByTimeAsync(0);
      expect(control.clients[0].eventSubscribeCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(control.clients[0].eventSubscribeCalls).toBe(3);
      expect(recovered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(control.clients[0].eventSubscribeCalls).toBe(4);
      expect(recovered).toHaveBeenCalledTimes(1);
      control.clients[0].eventHandler?.({ type: 'x' });
      expect(handler).toHaveBeenCalledTimes(1);

      control.subscribeEventsFailures.push(new FakeMisaoRpcError(-32000, 'busy'));
      control.clients[0].reconnect('refused');
      await vi.advanceTimersByTimeAsync(0);
      registration.unsubscribe();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(control.clients[0].eventSubscribeCalls).toBe(5);
      expect(recovered).toHaveBeenCalledTimes(1);
    });

    it('drops a subscription that succeeds after the last handler left', async () => {
      vi.useFakeTimers();
      const { connection, control } = setup();
      await connection.start();
      control.subscribeEventsFailures.push(new FakeMisaoRpcError(-32000, 'busy'));
      const registration = await connection.subscribeEvents(vi.fn());
      const held = control.clients[0].holdSubscribeEvents();
      await vi.advanceTimersByTimeAsync(100);
      registration.unsubscribe();
      held.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(control.clients[0].eventHandler).toBeUndefined();
      expect(control.clients[0].eventUnsubscribeCalls).toBe(1);
    });

    it('drops a subscription that succeeds after the connection was closed', async () => {
      vi.useFakeTimers();
      const { connection, control } = setup();
      await connection.start();
      control.subscribeEventsFailures.push(new FakeMisaoRpcError(-32000, 'busy'));
      await connection.subscribeEvents(vi.fn());
      const held = control.clients[0].holdSubscribeEvents();
      await vi.advanceTimersByTimeAsync(100);
      connection.close();
      held.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(control.clients[0].eventUnsubscribeCalls).toBe(1);
    });

    it('keeps the handlers registered and retries in the background when the first subscribe fails while connected', async () => {
      vi.useFakeTimers();
      const { connection, control, warn } = setup();
      await connection.start();
      control.subscribeEventsFailures.push(new FakeMisaoRpcError(-32000, 'busy'));
      const a = vi.fn();
      const b = vi.fn();
      const recovered = vi.fn();
      connection.onEventsRecovered(recovered);
      await Promise.all([connection.subscribeEvents(a), connection.subscribeEvents(b)]);
      expect(control.clients[0].eventSubscribeCalls).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('busy'));
      await vi.advanceTimersByTimeAsync(100);
      expect(control.clients[0].eventSubscribeCalls).toBe(2);
      expect(recovered).toHaveBeenCalledTimes(1);
      control.clients[0].eventHandler?.({ type: 'x' });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('rejects every waiting handler when the daemon is unreachable (a connection error) and registers none', async () => {
      const { connection, control } = setup();
      await connection.start();
      control.clients[0].reconnect('restored');
      control.subscribeEventsFailures.push(new FakeMisaoConnectionError('down'));
      const results = await Promise.allSettled([connection.subscribeEvents(vi.fn()), connection.subscribeEvents(vi.fn())]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      const late = vi.fn();
      await connection.subscribeEvents(late);
      control.clients[0].eventHandler?.({ type: 'x' });
      expect(late).toHaveBeenCalledTimes(1);
    });

    it('rejects every waiting handler when the subscription fails, and a later attempt can succeed', async () => {
      const { connection, control } = setup();
      await expect(connection.subscribeEvents(vi.fn())).rejects.toBeInstanceOf(MuxDriverUnavailableError);
      await connection.start();
      const ok = vi.fn();
      await connection.subscribeEvents(ok);
      control.clients[0].eventHandler?.({ type: 'x' });
      expect(ok).toHaveBeenCalledTimes(1);
    });
  });

  describe('lines', () => {
    it('subscribes a pane through the client and fans subscription errors out to listeners', async () => {
      const { connection, control } = setup();
      await connection.start();
      const handler = vi.fn();
      await connection.subscribeLines('p_1', handler);
      expect(control.clients[0].lineHandlers.get('p_1')).toBe(handler);
      const listener = vi.fn();
      const off = connection.onSubscriptionError(listener);
      const info = { stream: { kind: 'lines', paneId: 'p_1' }, error: new Error('refused') };
      for (const cb of control.clients[0].subscriptionErrorListeners) cb(info);
      expect(listener).toHaveBeenCalledWith(info);
      off();
      for (const cb of control.clients[0].subscriptionErrorListeners) cb(info);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    describe('line subscriptions across a client replacement', () => {
      async function replaceClient(connection: MisaoConnection, control: { clients: FakeClient[] }): Promise<void> {
        for (const cb of control.clients[0].stateListeners) cb({ status: 'reconnecting', attempt: 1, delayMs: 100, cause: new Error('lost') });
        for (const cb of control.clients[0].stateListeners) cb({ status: 'closed', cause: new FakeProtocolVersionError('server 2.0, client 1.0') } as never);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(connection.availability()).toEqual({ available: true });
      }

      it('re-subscribes on the new client from the last cursor so the existing handler keeps receiving lines, and releases the old subscription', async () => {
        vi.useFakeTimers();
        const { connection, control } = setup();
        await connection.start();
        const handler = vi.fn();
        await connection.subscribeLines('p_1', handler);
        control.clients[0].lineCursors.set('p_1', { seq: 42, epoch: 'e1' });

        await replaceClient(connection, control);
        expect(control.clients[0].lineUnsubscribes).toEqual(['p_1']);
        expect(control.clients[1].lineSubscribes).toEqual([{ paneId: 'p_1', options: { since: 42, epoch: 'e1' } }]);
        const line = { text: 'hello' };
        control.clients[1].lineHandlers.get('p_1')?.(line);
        expect(handler).toHaveBeenCalledWith(line);
      });

      it('does not re-subscribe a stream that was unsubscribed', async () => {
        vi.useFakeTimers();
        const { connection, control } = setup();
        await connection.start();
        const subscription = await connection.subscribeLines('p_1', vi.fn());
        subscription.unsubscribe();
        await replaceClient(connection, control);
        expect(control.clients[1].lineSubscribes).toEqual([]);
      });

      it('tells listeners when the daemon refuses a stream on the new client, and drops it', async () => {
        vi.useFakeTimers();
        const { connection, control } = setup();
        await connection.start();
        await connection.subscribeLines('p_1', vi.fn());
        const listener = vi.fn();
        connection.onSubscriptionError(listener);
        const original = control.clients;
        // The replacement client refuses the stream (e.g. the pane is gone).
        const refusing = new Error('no such pane');
        const make = original.push.bind(original);
        original.push = (...clients: FakeClient[]) => { clients.forEach((c) => { c.lineSubscribeFailure = refusing; }); return make(...clients); };

        await replaceClient(connection, control);
        await vi.advanceTimersByTimeAsync(0);
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ stream: { kind: 'lines', paneId: 'p_1' }, error: refusing }));
        // Dropped: another replacement does not try again.
        for (const cb of control.clients[1].stateListeners) cb({ status: 'closed', cause: new FakeProtocolVersionError('x') } as never);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(control.clients[2].lineSubscribes).toEqual([]);
      });
    });

    it('translates a connection error from subscribeLines and rejects before start', async () => {
      const { connection, control } = setup();
      await expect(connection.subscribeLines('p_1', () => {})).rejects.toBeInstanceOf(MuxDriverUnavailableError);
      await connection.start();
      control.subscribeLinesError = () => { throw new FakeMisaoConnectionError('not connected'); };
      await expect(connection.subscribeLines('p_1', () => {})).rejects.toBeInstanceOf(MuxDriverUnavailableError);
    });
  });

  describe('request', () => {
    it('rejects with daemon_unreachable before start', async () => {
      const { connection } = setup();
      await expect(connection.request('pane.list', {})).rejects.toMatchObject({ name: 'MuxDriverUnavailableError', reason: 'daemon_unreachable' });
    });

    it('translates a connection error into MuxDriverUnavailableError', async () => {
      const { connection, control } = setup();
      await connection.start();
      control.clients[0].requestHandler = () => { throw new FakeMisaoConnectionError('not connected'); };
      await expect(connection.request('pane.list', {})).rejects.toBeInstanceOf(MuxDriverUnavailableError);
    });

    it('passes RPC errors through and exposes their code', async () => {
      const { connection, control } = setup();
      await connection.start();
      const rpcError = new FakeMisaoRpcError(1001, 'pane not found');
      control.clients[0].requestHandler = () => { throw rpcError; };
      await expect(connection.request('pane.info', { paneId: 'p_x' })).rejects.toBe(rpcError);
      expect(connection.rpcErrorCode(rpcError)).toBe(1001);
      expect(connection.rpcErrorCode(new Error('x'))).toBeUndefined();
    });

    it('tells connection errors apart from RPC errors', () => {
      const { connection } = setup();
      expect(connection.isConnectionError(new FakeMisaoConnectionError('not connected'))).toBe(true);
      expect(connection.isConnectionError(new FakeMisaoRpcError(1001, 'pane not found'))).toBe(false);
    });
  });
});
