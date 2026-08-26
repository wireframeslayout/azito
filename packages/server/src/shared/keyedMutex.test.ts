import { describe, it, expect } from 'vitest';
import { KeyedMutex } from './keyedMutex';

// Issue #29 review (6th pass), Important finding 3: KeyedMutex is the
// serialization primitive `servers/routes.ts`'s isolation_intent
// false->true transition and `tmux/routes/sessions.ts`'s
// session/window/pane creation routes share (same instance, keyed by server
// name) — see both files' `serverIsolationMutex` doc comments. These are
// plain unit tests of the mutex itself, independent of either route file.
describe('KeyedMutex', () => {
  it('serializes calls under the same key: the second call only starts after the first resolves', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.withLock('server-a', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    // Give the first call a chance to actually start before queuing the second.
    await Promise.resolve();

    const second = mutex.withLock('server-a', async () => {
      order.push('second-start');
    });

    // The second call must not have started yet — it is queued behind the first.
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await first;
    await second;

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('does not serialize calls under different keys', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = mutex.withLock('server-a', async () => {
      order.push('a-start');
      await gateA;
      order.push('a-end');
    });
    await Promise.resolve();

    // A call under a different key must proceed immediately, without waiting for 'a'.
    const b = mutex.withLock('server-b', async () => {
      order.push('b-start');
    });
    await b;
    expect(order).toEqual(['a-start', 'b-start']);

    releaseA();
    await a;
    expect(order).toEqual(['a-start', 'b-start', 'a-end']);
  });

  it('lets the next caller under the same key proceed even after the prior run rejects', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.withLock('server-a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A failed prior run must not poison the chain for the next caller.
    const result = await mutex.withLock('server-a', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('returns the value fn resolves with', async () => {
    const mutex = new KeyedMutex();
    const result = await mutex.withLock('k', async () => 42);
    expect(result).toBe(42);
  });
});
