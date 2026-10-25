import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { ProcessLock, ProcessLockBusyError, misaoRootLockEndpoint } from './processLock';

/** On Windows the lock is a named pipe; a unix socket path has the same "one listener" rule and serves these tests elsewhere. */
describe('ProcessLock', () => {
  let dir: string;
  let endpoint: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azlock-'));
    endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\azito-lock-test-${path.basename(dir)}` : path.join(dir, 'l.sock');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the operation and returns its result, and the lock is free afterwards', async () => {
    const lock = new ProcessLock(endpoint, 111);
    expect(await lock.run(async () => 'ok')).toBe('ok');
    expect(await lock.run(async () => 'again')).toBe('again');
  });

  it('releases the lock when the operation fails, and passes the failure on', async () => {
    const lock = new ProcessLock(endpoint, 111);
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run(async () => 'free')).toBe('free');
  });

  it('is busy at once, without waiting, while it is held, and names the holder', async () => {
    const holder = new ProcessLock(endpoint, 4242);
    const other = new ProcessLock(endpoint, 100);
    let ran = false;
    await holder.run(async () => {
      const refused = await other.run(async () => { ran = true; }).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ProcessLockBusyError);
      expect((refused as ProcessLockBusyError).ownerPid).toBe(4242);
    });
    expect(ran).toBe(false);
    await other.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('lets exactly one of several takers that come at the same time in', async () => {
    let inside = 0;
    let maxInside = 0;
    const take = (pid: number): Promise<'in' | 'busy'> => new ProcessLock(endpoint, pid).run(async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inside -= 1;
      return 'in' as const;
    }).catch((err: unknown) => {
      if (err instanceof ProcessLockBusyError) return 'busy' as const;
      throw err;
    });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(take));
    expect(results.filter((r) => r === 'in')).toHaveLength(1);
    expect(maxInside).toBe(1);
  });
});

describe('misaoRootLockEndpoint', () => {
  it('is one pipe per folder: the same for another letter case or a trailing separator, different for another folder', () => {
    const a = misaoRootLockEndpoint('C:\\Users\\Me\\.azito\\misao');
    expect(a).toMatch(/^\\\\\.\\pipe\\azito-lock-[0-9a-f]{16}$/);
    expect(misaoRootLockEndpoint('c:\\users\\me\\.azito\\MISAO\\')).toBe(a);
    expect(misaoRootLockEndpoint('C:\\Users\\Other\\.azito\\misao')).not.toBe(a);
  });
});
