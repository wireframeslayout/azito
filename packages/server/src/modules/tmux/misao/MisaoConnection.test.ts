import { afterEach, describe, expect, it, vi } from 'vitest';
import { MisaoConnection, type MisaoSdk } from './MisaoConnection';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';

type StateListener = (state: { status: 'connected' } | { status: 'reconnecting'; attempt: number; delayMs: number; cause: Error } | { status: 'closed' }) => void;

class FakeMisaoConnectionError extends Error {}
class FakeMisaoRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

interface FakeClientControl {
  clients: FakeClient[];
  /** Errors returned by successive connect() calls; once empty, connect succeeds. */
  connectFailures: Error[];
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
  async subscribeEvents(): Promise<{ unsubscribe(): void; cursor: { seq: number; epoch: string } }> {
    return { unsubscribe: () => {}, cursor: { seq: 0, epoch: 'e' } };
  }
  close(): void { this.closed = true; }
}

/** A stand-in for the ESM-only SDK module: only what MisaoConnection touches. */
function createFakeSdk(): { sdk: MisaoSdk; control: FakeClientControl } {
  const control: FakeClientControl = { clients: [], connectFailures: [] };
  const sdk = {
    MisaoClient: function MisaoClient() {
      const client = new FakeClient(control);
      control.clients.push(client);
      return client;
    },
    MisaoConnectionError: FakeMisaoConnectionError,
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

  it('stops retrying on a non-connection failure such as a protocol mismatch', async () => {
    vi.useFakeTimers();
    const { connection, control, warn } = setup();
    control.connectFailures.push(new Error('incompatible protocol version'));
    await connection.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(control.clients[0].connectCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('giving up'));
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
  });
});
