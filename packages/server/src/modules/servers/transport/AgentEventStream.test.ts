import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { AgentEventStream } from './AgentEventStream';
import { NotificationBus } from '../../notifications/NotificationBus';

/** Minimal ws.WebSocket stand-in that always fails to open, forcing reconnect scheduling. */
class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  static autoClose = true;
  ping = vi.fn();
  terminate = vi.fn(() => this.emit('close'));

  constructor(_url: string, _opts?: unknown) {
    super();
    MockWebSocket.instances.push(this);
    // Fail on next tick so `connect()` has finished wiring listeners first.
    if (MockWebSocket.autoClose) setTimeout(() => this.emit('close'), 0);
  }

  close(): void {
    /* no-op */
  }
}

vi.mock('ws', () => ({
  default: class {
    constructor(url: string, opts?: unknown) {
      return new MockWebSocket(url, opts) as unknown as never;
    }
  },
}));

describe('AgentEventStream reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    MockWebSocket.autoClose = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects after a stalled handshake or missed pongs', async () => {
    MockWebSocket.autoClose = false;
    const stream = new AgentEventStream('test-server', 'ws://example.invalid', 'Bearer token', new NotificationBus());
    stream.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(MockWebSocket.instances[0].terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    const socket = MockWebSocket.instances[1];
    socket.emit('open');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).toHaveBeenCalledOnce();
    stream.stop();
  });

  it('keeps retrying indefinitely past the old 10-attempt cap', async () => {
    const bus = new NotificationBus();
    const stream = new AgentEventStream('test-server', 'ws://example.invalid', 'Bearer token', bus);

    stream.start();

    // Drive well past 10 reconnect attempts: each cycle is (microtask close) + backoff delay
    // (capped at 30s). Advancing time repeatedly lets every scheduled retry fire.
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(30000);
    }

    // Old behavior: scheduleReconnect() gave up after retryCount > 10, so at most 11
    // connection attempts (1 initial + 10 retries) would ever occur.
    expect(MockWebSocket.instances.length).toBeGreaterThan(11);

    stream.stop();
  });
});
