import { describe, it, expect } from 'vitest';
import { createReconnectCounter, type ReconnectDecision } from './reconnectCounter';

const opts = { maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 15000, stableMs: 5000 };

function openThenClose(counter: ReturnType<typeof createReconnectCounter>, at: number, heldMs: number): ReconnectDecision {
  counter.onOpen(at);
  return counter.onClose(at + heldMs);
}

describe('createReconnectCounter', () => {
  it('(a) gives up after 8 immediate open-close cycles', () => {
    const counter = createReconnectCounter(opts);
    for (let i = 1; i <= 8; i++) {
      const d = openThenClose(counter, i * 100, 0);
      expect(d).toMatchObject({ action: 'reconnect', attempt: i });
    }
    expect(openThenClose(counter, 1000, 0)).toEqual({ action: 'give_up' });
  });

  it('(b) message receipt between open and close does not affect the counter', () => {
    const counter = createReconnectCounter(opts);
    for (let i = 1; i <= 8; i++) {
      counter.onOpen(i * 100);
      // error text arrives via onmessage: no counter call involved
      expect(counter.onClose(i * 100 + 10)).toMatchObject({ action: 'reconnect', attempt: i });
    }
    expect(counter.onClose(2000)).toEqual({ action: 'give_up' });
  });

  it('(c) resets after a stable connection and restarts from attempt 1', () => {
    const counter = createReconnectCounter(opts);
    openThenClose(counter, 0, 0);
    openThenClose(counter, 100, 0);
    expect(openThenClose(counter, 200, 5000)).toEqual({ action: 'reconnect', attempt: 1, delayMs: 1000 });
  });

  it('(d) backs off 1s, 2s, 4s, 8s, 15s, 15s, 15s, 15s then gives up', () => {
    const counter = createReconnectCounter(opts);
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const d = counter.onClose(i);
      if (d.action === 'reconnect') delays.push(d.delayMs);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
    expect(counter.onClose(9)).toEqual({ action: 'give_up' });
  });

  it('(e) can reach the limit again after a reset', () => {
    const counter = createReconnectCounter(opts);
    for (let i = 0; i < 8; i++) counter.onClose(i);
    expect(openThenClose(counter, 100, 6000)).toMatchObject({ action: 'reconnect', attempt: 1 });
    for (let i = 2; i <= 8; i++) {
      expect(openThenClose(counter, 10000 + i, 0)).toMatchObject({ action: 'reconnect', attempt: i });
    }
    expect(openThenClose(counter, 20000, 0)).toEqual({ action: 'give_up' });
  });

  it('isFirstAttempt is true only before any reconnect is scheduled', () => {
    const counter = createReconnectCounter(opts);
    expect(counter.isFirstAttempt()).toBe(true);
    counter.onOpen(0);
    expect(counter.isFirstAttempt()).toBe(true);
    counter.onClose(10);
    expect(counter.isFirstAttempt()).toBe(false);
  });
});
