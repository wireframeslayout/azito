import fs from 'fs';
import path from 'path';
import type { SecretFileGuard } from './os/secretFileGuard';

/** One at a time, across processes. Not queued: when it is taken, {@link run} throws {@link ProcessLockBusyError} at once. */
export interface ExclusiveLock {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** Who holds a lock, as the holder wrote it for display (never used to decide who holds it). */
export interface LockOwner {
  pid: number;
  started: string;
}

/** Another process (or another holder in this one) has the lock. `owner` is what the holder recorded, undefined when that cannot be read. */
export class ProcessLockBusyError extends Error {
  constructor(readonly file: string, readonly owner: LockOwner | undefined) {
    super(`${file} is held${owner ? ` by process ${owner.pid} (started ${owner.started})` : ' by a process that could not be identified'}`);
    this.name = 'ProcessLockBusyError';
  }
}

/**
 * libuv's `UV_FS_O_EXLOCK` (uv/win.h): open with sharing mode 0. Node does not export it in `fs.constants`, but passes a numeric `flags` to
 * `uv_fs_open` as it is; the test `processLock.windows.test.ts` is what shows, on a real Windows, that it takes effect.
 */
const UV_FS_O_EXLOCK = 0x10000000;

/** What Windows answers to an open that the sharing mode of the holder refuses (libuv: ERROR_SHARING_VIOLATION -> EBUSY, ERROR_ACCESS_DENIED on a held handle -> EPERM). */
const REFUSED_BECAUSE_HELD = new Set(['EBUSY', 'EPERM']);

/**
 * One-at-a-time across processes on Windows, by a file only one handle can have open: `UV_FS_O_EXLOCK` makes libuv open it with sharing
 * mode 0, so no other process (and no other open in this one) can open it while the handle lives, and the OS closes the handle when the
 * holder dies however it dies. There is no stale lock to judge or take over, and nothing for two takers to race on: the open succeeds for
 * exactly one of them, the rest are refused (`busy`, at once, never waited for).
 *
 * Who can take it first: only someone who can create or open the file, so the folder that holds it must be writable by this user alone.
 * That is checked before every acquisition (the folder, and the lock file, against the secret-file policy), and a folder or file that is
 * not owner-only fails with the reason; a missing folder is made owner-only. The lock file is made owner-only before it is first opened.
 *
 * The owner file (the holder's pid and start time) is written once the lock is held and removed on release, so that a
 * refused taker can say who has it. It is for display only: it decides nothing, and a taker that cannot read it says the holder is unknown.
 */
export class FileLock implements ExclusiveLock {
  constructor(
    private readonly file: string,
    private readonly ownerFile: string,
    private readonly guard: SecretFileGuard,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (process.platform !== 'win32') throw new Error('An exclusive file lock is only available on Windows');
    this.requirePrivate();
    let fd: number;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDWR | fs.constants.O_CREAT | UV_FS_O_EXLOCK, 0o600);
    } catch (err) {
      if (REFUSED_BECAUSE_HELD.has((err as NodeJS.ErrnoException).code ?? '')) throw new ProcessLockBusyError(this.file, this.readOwner());
      throw err;
    }
    try {
      const started = new Date(Date.now() - process.uptime() * 1000).toISOString();
      this.guard.writeSecretFile(this.ownerFile, JSON.stringify({ pid: process.pid, started } satisfies LockOwner));
      return await operation();
    } finally {
      fs.rmSync(this.ownerFile, { force: true });
      fs.closeSync(fd);
    }
  }

  /** The folder is owner-only (made so when missing, never silently changed when it exists), and so is the lock file (made so before it is opened the first time). */
  private requirePrivate(): void {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) this.guard.ensureProtectedDir(dir);
    this.requireOk(dir, 'dir');
    if (!fs.existsSync(this.file)) this.guard.prepareFile(this.file);
    this.requireOk(this.file, 'file');
  }

  private requireOk(target: string, kind: 'file' | 'dir'): void {
    const verdict = this.guard.inspect(target, kind);
    if (!verdict.ok) throw new Error(`${target} is not private to this user (${verdict.summary}), so the misao lock in it could be taken first by someone else. ${verdict.fix}`);
  }

  private readOwner(): LockOwner | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ownerFile, 'utf-8')) as Partial<LockOwner>;
      return typeof parsed.pid === 'number' && typeof parsed.started === 'string' ? { pid: parsed.pid, started: parsed.started } : undefined;
    } catch {
      return undefined; // not written yet, already removed, or not readable: the holder is unknown
    }
  }
}
