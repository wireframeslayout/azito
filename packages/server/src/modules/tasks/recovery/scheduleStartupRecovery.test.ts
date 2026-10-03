import { describe, it, expect, vi } from 'vitest';
import { scheduleStartupRecovery } from './scheduleStartupRecovery';

function fakeConnection(connected: boolean) {
  let state = connected;
  const listeners = new Set<() => void>();
  return {
    availability: () => (state ? { available: true as const } : { available: false as const, reason: 'daemon_unreachable' as const }),
    onConnected: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    connect: () => { state = true; for (const l of [...listeners]) l(); },
  };
}

describe('scheduleStartupRecovery', () => {
  it('without misao, recovers once and never runs the skipped-task pass', async () => {
    const recover = vi.fn(async () => {});
    const recoverSkipped = vi.fn(async () => {});
    await scheduleStartupRecovery(recover, recoverSkipped, undefined);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recoverSkipped).not.toHaveBeenCalled();
  });

  it('recovers once when the daemon is already connected', async () => {
    const recover = vi.fn(async () => {});
    const recoverSkipped = vi.fn(async () => {});
    await scheduleStartupRecovery(recover, recoverSkipped, fakeConnection(true));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recoverSkipped).not.toHaveBeenCalled();
  });

  it('recovers at once without waiting for the daemon, then only the skipped tasks on its first (late) connection', async () => {
    const recover = vi.fn(async () => {});
    const recoverSkipped = vi.fn(async () => {});
    const connection = fakeConnection(false);

    await scheduleStartupRecovery(recover, recoverSkipped, connection);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recoverSkipped).not.toHaveBeenCalled();

    connection.connect();
    await vi.waitFor(() => expect(recoverSkipped).toHaveBeenCalledTimes(1));
    expect(recover).toHaveBeenCalledTimes(1);

    connection.connect();
    await Promise.resolve();
    expect(recoverSkipped).toHaveBeenCalledTimes(1);
  });

  it('does not start the skipped-task pass while the first pass is still running', async () => {
    let release!: () => void;
    const recover = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const recoverSkipped = vi.fn(async () => {});
    const connection = fakeConnection(false);

    const first = scheduleStartupRecovery(recover, recoverSkipped, connection);
    connection.connect();
    await Promise.resolve();
    expect(recoverSkipped).not.toHaveBeenCalled();

    release();
    await first;
    await vi.waitFor(() => expect(recoverSkipped).toHaveBeenCalledTimes(1));
  });
});
