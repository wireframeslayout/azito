import * as fs from 'fs';
import * as path from 'path';

/** Who holds a lock: the process id AND when that process started (an id can be handed to another process once it has ended). */
export interface ProcessLockOwner {
  pid: number;
  started: string;
}

/** What the lock needs to know about processes; the host supplies it (on Windows: `agent/parentWatch`). */
export interface ProcessLockHost {
  /** This process's id. */
  pid: number;
  /** Whether a process with this id exists. */
  exists(pid: number): boolean;
  /** When a process started, as a string that is the same every time it is read for the same process; null when it cannot be read (no such process, no answer). */
  readStart(pid: number): Promise<string | null>;
}

/** Another process holds the lock. */
export class ProcessLockBusyError extends Error {
  constructor(readonly file: string, readonly owner: ProcessLockOwner | undefined) {
    super(owner ? `${file} is held by process ${owner.pid}` : `${file} is held by another process`);
    this.name = 'ProcessLockBusyError';
  }
}

/** A lock that is half-written for longer than this was left by a process that died while writing it. */
const UNREADABLE_STALE_MS = 10_000;

/**
 * One-at-a-time across processes, by a file: created exclusively (`wx`) with the owner's process id and start time. A file whose owner
 * is not running any more (no such process, or a process of that id that started at another time) is a stale lock and is taken over;
 * a lock is always released (only if the file still names this process). Not queued: when it is held, {@link run} throws
 * {@link ProcessLockBusyError} at once, and the caller says so or looks again later.
 *
 * Two processes that both find the same stale file can still race on removing it; the loser's exclusive create then fails and it
 * reports busy, which is the safe side. A process that is killed leaves its file until the next taker finds it stale.
 */
export class ProcessLock {
  private selfStart: string | undefined;

  constructor(private readonly file: string, private readonly host: ProcessLockHost) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const self = await this.self();
    await this.acquire(self);
    try {
      return await operation();
    } finally {
      this.release(self);
    }
  }

  private async self(): Promise<ProcessLockOwner> {
    this.selfStart ??= (await this.host.readStart(this.host.pid)) ?? undefined;
    if (this.selfStart === undefined) throw new Error(`Cannot tell when this process (${this.host.pid}) started, so it cannot take ${this.file}`);
    return { pid: this.host.pid, started: this.selfStart };
  }

  private async acquire(self: ProcessLockOwner): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.tryCreate(self)) return;
    const held = this.read();
    if (held.state === 'owned' && (await this.isRunning(held.owner))) throw new ProcessLockBusyError(this.file, held.owner);
    if (held.state === 'unreadable' && !held.stale) throw new ProcessLockBusyError(this.file, undefined);
    if (held.state === 'gone') {
      if (this.tryCreate(self)) return;
      throw new ProcessLockBusyError(this.file, undefined);
    }
    // Stale: its owner is gone. Taken over only if it is still the file that was judged.
    const again = this.read();
    if (again.state === 'owned' && held.state === 'owned' && (again.owner.pid !== held.owner.pid || again.owner.started !== held.owner.started)) {
      throw new ProcessLockBusyError(this.file, again.owner);
    }
    fs.rmSync(this.file, { force: true });
    if (!this.tryCreate(self)) throw new ProcessLockBusyError(this.file, undefined);
  }

  private tryCreate(self: ProcessLockOwner): boolean {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(self));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  private read(): { state: 'owned'; owner: ProcessLockOwner } | { state: 'unreadable'; stale: boolean } | { state: 'gone' } {
    let text: string;
    let mtimeMs: number;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'gone' };
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Partial<ProcessLockOwner>;
      if (typeof parsed.pid === 'number' && typeof parsed.started === 'string') return { state: 'owned', owner: { pid: parsed.pid, started: parsed.started } };
    } catch {
      // not JSON: unreadable, below
    }
    return { state: 'unreadable', stale: Date.now() - mtimeMs > UNREADABLE_STALE_MS };
  }

  private async isRunning(owner: ProcessLockOwner): Promise<boolean> {
    if (!this.host.exists(owner.pid)) return false;
    // A running process whose start cannot be read is taken for the owner: a lock is never taken over on a guess.
    const start = await this.host.readStart(owner.pid);
    return start === null || start === owner.started;
  }

  private release(self: ProcessLockOwner): void {
    const held = this.read();
    if (held.state === 'owned' && held.owner.pid === self.pid && held.owner.started === self.started) fs.rmSync(this.file, { force: true });
  }
}
