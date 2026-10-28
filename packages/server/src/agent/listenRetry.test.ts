import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { abortableSleep, listenWithRetry } from './listenRetry';

function listenError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`listen ${code}: address not available 100.64.0.1:3002`), { code });
}

function setup() {
  let clock = 0;
  const now = (): number => clock;
  const sleep = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(async (ms) => {
    clock += ms;
  });
  return { log: { warn: vi.fn<(message: string) => void>() }, sleep, now, advance: (ms: number) => { clock += ms; }, controller: new AbortController() };
}

describe('listenWithRetry', () => {
  it('listens once when the address is there', async () => {
    const { log, sleep, now, controller } = setup();
    const listen = vi.fn(async () => undefined);
    await expect(listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now })).resolves.toBe('listening');
    expect(listen).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('starts after EADDRNOTAVAIL a few times, logging the reason once', async () => {
    const { log, sleep, now, controller } = setup();
    const listen = vi.fn()
      .mockRejectedValueOnce(listenError('EADDRNOTAVAIL'))
      .mockRejectedValueOnce(listenError('EADDRNOTAVAIL'))
      .mockRejectedValueOnce(listenError('EADDRNOTAVAIL'))
      .mockResolvedValueOnce(undefined);
    await expect(listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now, intervalMs: 5000 })).resolves.toBe('listening');
    expect(listen).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain('100.64.0.1');
    expect(message).toContain('Tailscale');
    expect(message).toContain('attempt 1');
    expect(message).toContain('left');
  });

  it('logs again once per minute, not on every attempt', async () => {
    const { log, sleep, now, controller } = setup();
    let calls = 0;
    const listen = vi.fn(async () => {
      if (++calls <= 25) throw listenError('EADDRNOTAVAIL');
    });
    await listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now, intervalMs: 5000, maxWaitMs: 600_000, logEveryMs: 60_000 });
    // waited 0s, 60s, 120s -> 3 logs over 24 waits of 5s
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('ends with the reason once the limit is reached', async () => {
    const { log, sleep, now, controller } = setup();
    const listen = vi.fn(async () => { throw listenError('EADDRNOTAVAIL'); });
    await expect(
      listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now, intervalMs: 5000, maxWaitMs: 20_000 }),
    ).rejects.toThrow(/100\.64\.0\.1:3002 was still not available after waiting 20s \(5 attempts\); is Tailscale connected/);
    expect(listen).toHaveBeenCalledTimes(5);
  });

  it.each(['EADDRINUSE', 'EACCES'])('ends at once on %s', async (code) => {
    const { log, sleep, now, controller } = setup();
    const listen = vi.fn(async () => { throw listenError(code); });
    await expect(listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now })).rejects.toMatchObject({ code });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops waiting when the signal aborts', async () => {
    const { log, controller } = setup();
    const listen = vi.fn(async () => { throw listenError('EADDRNOTAVAIL'); });
    const result = listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, intervalMs: 60_000 });
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    const started = Date.now();
    controller.abort();
    await expect(result).resolves.toBe('aborted');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('reports aborted when the stop came during the last, successful listen', async () => {
    const { log, sleep, now, controller } = setup();
    const listen = vi.fn(async () => { controller.abort(); });
    await expect(listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now })).resolves.toBe('aborted');
  });

  it('judges the limit by elapsed time, including the time a listen takes, and never sleeps past it', async () => {
    const { log, sleep, now, advance, controller } = setup();
    const listen = vi.fn(async () => {
      advance(4000); // a listen that takes 4 s
      throw listenError('EADDRNOTAVAIL');
    });
    await expect(
      listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now, intervalMs: 5000, maxWaitMs: 20_000 }),
    ).rejects.toThrow(/after waiting 22s/);
    // 4 s listen + 5 s sleep per round: fails at 4, 13 (sleep 5), 22 >= 20
    expect(listen).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 5000]);
  });

  it('does not listen at all when already aborted', async () => {
    const { log, sleep, now, controller } = setup();
    controller.abort();
    const listen = vi.fn(async () => undefined);
    await expect(listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: controller.signal, sleep, now })).resolves.toBe('aborted');
    expect(listen).not.toHaveBeenCalled();
  });

  it('can listen again on the same Fastify server after a failed listen (any OS)', async () => {
    const app = Fastify();
    app.get('/', async () => 'ok');
    const { log, controller } = setup();
    // 192.0.2.0/24 (TEST-NET-1) is never assigned to a local interface: EADDRNOTAVAIL on Linux, macOS and Windows alike.
    let attempts = 0;
    const result = await listenWithRetry({
      listen: () => app.listen({ port: 0, host: ++attempts < 3 ? '192.0.2.1' : '127.0.0.1' }),
      bind: '192.0.2.1',
      port: 0,
      log,
      signal: controller.signal,
      sleep: async () => undefined,
    });
    expect(result).toBe('listening');
    expect(attempts).toBe(3);
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    await app.close();
  });
});

describe('abortableSleep', () => {
  it('resolves after the time', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void abortableSleep(1000, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
