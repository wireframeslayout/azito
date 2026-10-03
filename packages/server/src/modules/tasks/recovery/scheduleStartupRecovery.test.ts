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
  it('without misao, recovers once', async () => {
    const recover = vi.fn(async () => {});
    await scheduleStartupRecovery(recover, undefined);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('recovers once when the daemon is already connected', async () => {
    const recover = vi.fn(async () => {});
    await scheduleStartupRecovery(recover, fakeConnection(true));
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('recovers at once without waiting for the daemon, then once more on its first (late) connection', async () => {
    const recover = vi.fn(async () => {});
    const connection = fakeConnection(false);

    await scheduleStartupRecovery(recover, connection);
    expect(recover).toHaveBeenCalledTimes(1);

    connection.connect();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));

    connection.connect();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('does not overlap the second pass with a first pass still running', async () => {
    let release!: () => void;
    const recover = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValue(undefined);
    const connection = fakeConnection(false);

    const first = scheduleStartupRecovery(recover, connection);
    connection.connect();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);

    release();
    await first;
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
  });
});
