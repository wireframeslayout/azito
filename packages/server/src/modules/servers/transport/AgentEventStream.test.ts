import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { AgentEventStream } from './AgentEventStream';
import { NotificationBus } from '../../notifications/NotificationBus';

/** Minimal ws.WebSocket stand-in that always fails to open, forcing reconnect scheduling. */
class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];

  constructor(_url: string, _opts?: unknown) {
    super();
    MockWebSocket.instances.push(this);
    // Fail on next tick so `connect()` has finished wiring listeners first.
    setTimeout(() => this.emit('close'), 0);
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
  });

  afterEach(() => {
    vi.useRealTimers();
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
