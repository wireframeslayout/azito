import { describe, it, expect, vi } from 'vitest';
import { createAgentLifecycle, type StopSignal } from './agentLifecycle';
import { listenWithRetry } from './listenRetry';

function setup(close: () => Promise<void> = async () => undefined) {
  const handlers = new Map<StopSignal, () => void>();
  const exit = vi.fn<(code: number) => void>();
  const timers: Array<() => void> = [];
  const log = { info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>() };
  const closeFn = vi.fn(close);
  const lifecycle = createAgentLifecycle({
    onSignal: (signal, handler) => handlers.set(signal, handler),
    close: closeFn,
    exit,
    log,
    hardCapMs: 8000,
    setTimer: (callback) => {
      timers.push(callback);
      return { unref: () => undefined };
    },
  });
  return { lifecycle, handlers, exit, timers, log, close: closeFn };
}

describe('createAgentLifecycle', () => {
  it('registers all three stop signals', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
  });

  it('a signal before listening aborts the startup and does not shut down by itself', () => {
    const { lifecycle, handlers, close, exit } = setup();
    handlers.get('SIGTERM')?.();
    expect(lifecycle.startupSignal.aborted).toBe(true);
    expect(lifecycle.startupStopReason).toBe('SIGTERM');
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('the parent being gone before listening aborts the startup, with its reason', () => {
    const { lifecycle } = setup();
    lifecycle.requestStop('parent process 1234 is gone');
    expect(lifecycle.startupSignal.aborted).toBe(true);
    expect(lifecycle.startupStopReason).toBe('parent process 1234 is gone');
  });

  it('keeps the first reason when several stops come while waiting', () => {
    const { lifecycle, handlers } = setup();
    lifecycle.requestStop('parent gone');
    handlers.get('SIGINT')?.();
    expect(lifecycle.startupStopReason).toBe('parent gone');
  });

  it('after listening, a stop closes the server and exits with 0; a second one is ignored', async () => {
    const { lifecycle, handlers, close, exit } = setup();
    lifecycle.markListening();
    handlers.get('SIGTERM')?.();
    handlers.get('SIGINT')?.();
    expect(lifecycle.startupSignal.aborted).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('shutdown after an aborted startup closes the server (the last listen won the race)', async () => {
    const { lifecycle, handlers, close, exit } = setup();
    handlers.get('SIGTERM')?.();
    lifecycle.shutdown(lifecycle.startupStopReason ?? 'x');
    expect(close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('forces the exit through the hard cap when closing hangs', () => {
    const { lifecycle, timers, exit, log } = setup(() => new Promise<void>(() => undefined));
    lifecycle.markListening();
    lifecycle.requestStop('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('exits even when closing fails', async () => {
    const { lifecycle, exit } = setup(async () => { throw new Error('boom'); });
    lifecycle.markListening();
    lifecycle.requestStop('SIGHUP');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});

describe('lifecycle wired to listenWithRetry', () => {
  const unavailable = Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' });
  const log = { warn: vi.fn<(m: string) => void>() };

  it('the parent gone while waiting ends the wait', async () => {
    const { lifecycle } = setup();
    const listen = vi.fn(async () => { throw unavailable; });
    const result = listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: lifecycle.startupSignal, intervalMs: 60_000 });
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    lifecycle.requestStop('parent gone');
    await expect(result).resolves.toBe('aborted');
  });

  it('a signal during the last, successful listen is reported as aborted', async () => {
    const { lifecycle, handlers } = setup();
    const listen = vi.fn(async () => { handlers.get('SIGTERM')?.(); });
    await expect(listenWithRetry({ listen, bind: '100.64.0.1', port: 3002, log, signal: lifecycle.startupSignal })).resolves.toBe('aborted');
  });
});
