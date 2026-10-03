import { describe, it, expect, vi } from 'vitest';
import { scheduleStartupRecovery } from './scheduleStartupRecovery';

function fakeConnection(connected: boolean) {
  let state = connected;
  const listeners = new Set<() => void>();
  return {
    availability: () => (state ? { available: true as const } : { available: false as const, reason: 'daemon_unreachable' as const }),
    onConnected: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    connect: () => { state = true; for (const l of [...listeners]) l(); },
    listenerCount: () => listeners.size,
  };
}

/** `pending` is consumed one entry per skipped-task pass: the number of tasks still pending afterwards. */
function fakeRecovery(pendingAfterEachPass: number[], initiallyPending = 1) {
  let pending = initiallyPending;
  const passes = [...pendingAfterEachPass];
  return {
    recover: vi.fn(async () => {}),
    recoverSkipped: vi.fn(async () => { pending = passes.shift() ?? 0; }),
    hasPending: () => pending > 0,
  };
}

describe('scheduleStartupRecovery', () => {
  it('without misao, recovers once and never runs the skipped-task pass', async () => {
    const recovery = fakeRecovery([]);
    await scheduleStartupRecovery(recovery, undefined);
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    expect(recovery.recoverSkipped).not.toHaveBeenCalled();
  });

  it('recovers once when the daemon is already connected', async () => {
    const recovery = fakeRecovery([]);
    await scheduleStartupRecovery(recovery, fakeConnection(true));
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    expect(recovery.recoverSkipped).not.toHaveBeenCalled();
  });

  it('recovers at once without waiting for the daemon, then only the deferred tasks on its connection', async () => {
    const recovery = fakeRecovery([0]);
    const connection = fakeConnection(false);

    await scheduleStartupRecovery(recovery, connection);
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    expect(recovery.recoverSkipped).not.toHaveBeenCalled();

    connection.connect();
    await vi.waitFor(() => expect(recovery.recoverSkipped).toHaveBeenCalledTimes(1));
    expect(recovery.recover).toHaveBeenCalledTimes(1);
    // nothing is pending any more: the listener is gone
    await vi.waitFor(() => expect(connection.listenerCount()).toBe(0));
  });

  it('keeps retrying on later connections while a task is still pending, and stops once none is', async () => {
    const recovery = fakeRecovery([1, 0]);
    const connection = fakeConnection(false);

    await scheduleStartupRecovery(recovery, connection);
    connection.connect();
    await vi.waitFor(() => expect(recovery.recoverSkipped).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(connection.listenerCount()).toBe(1));

    connection.connect();
    await vi.waitFor(() => expect(recovery.recoverSkipped).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(connection.listenerCount()).toBe(0));
  });

  it('stops listening right away when the first run leaves nothing pending', async () => {
    const recovery = fakeRecovery([], 0);
    const connection = fakeConnection(false);

    await scheduleStartupRecovery(recovery, connection);

    await vi.waitFor(() => expect(connection.listenerCount()).toBe(0));
    expect(recovery.recoverSkipped).not.toHaveBeenCalled();
  });

  it('does not start the skipped-task pass while the first pass is still running', async () => {
    let release!: () => void;
    const recovery = fakeRecovery([0]);
    recovery.recover.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const connection = fakeConnection(false);

    const first = scheduleStartupRecovery(recovery, connection);
    connection.connect();
    await Promise.resolve();
    expect(recovery.recoverSkipped).not.toHaveBeenCalled();

    release();
    await first;
    await vi.waitFor(() => expect(recovery.recoverSkipped).toHaveBeenCalledTimes(1));
  });
});
