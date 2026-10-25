import { ProcessLockBusyError, type ExclusiveLock } from './processLock';

/** Where an in-memory lock is held (tests share one per "folder"). */
export interface MemorySlot {
  holder?: number;
}

/** The semantics of `FileLock` without a file or Windows, for the tests of what sits on top of it: taken means busy at once, released always. */
export class MemoryLock implements ExclusiveLock {
  constructor(private readonly slot: MemorySlot, private readonly pid: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.slot.holder !== undefined) throw new ProcessLockBusyError('memory', { pid: this.slot.holder, started: 'test' });
    this.slot.holder = this.pid;
    try {
      return await operation();
    } finally {
      this.slot.holder = undefined;
    }
  }
}
