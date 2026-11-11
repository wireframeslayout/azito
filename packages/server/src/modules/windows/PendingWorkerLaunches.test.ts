import { describe, expect, it, vi } from 'vitest';
import { PendingWorkerLaunches } from './PendingWorkerLaunches';

const ref = { kind: 'misao', workspace: 'ws', window: 'w_0123456789ABCDEFGHJKMNPQRS' } as const;
const record = { workerType: 'claude' as const, args: ['--dangerously-skip-permissions'] };

describe('pending worker launches', () => {
  it('ties the one-use record to the server and window', () => {
    const pending = new PendingWorkerLaunches();
    pending.record('one', ref, record);
    expect(pending.take('two', ref)).toBeNull();
    expect(pending.take('one', ref)).toEqual(record);
    expect(pending.take('one', ref)).toBeNull();
  });
  it('discards expired and replaced records', () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingWorkerLaunches();
      pending.record('one', ref, record);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(pending.take('one', ref)).toBeNull();
      pending.record('one', ref, record);
      pending.record('one', ref, null);
      expect(pending.take('one', ref)).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
