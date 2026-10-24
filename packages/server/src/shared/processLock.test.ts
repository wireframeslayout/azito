import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessLock, ProcessLockBusyError, type ProcessLockHost } from './processLock';

/** A host with scripted processes: id -> start time (a process that is not in the table does not exist). */
function host(pid: number, table: Map<number, string>): ProcessLockHost {
  return { pid, exists: (p) => table.has(p), readStart: async (p) => table.get(p) ?? null };
}

describe('ProcessLock', () => {
  let dir: string;
  let file: string;
  let table: Map<number, string>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azlock-'));
    file = path.join(dir, 'misao', '.operation.lock');
    table = new Map([[100, 't100'], [200, 't200']]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the operation holding a file that names this process, and releases it afterwards', async () => {
    const lock = new ProcessLock(file, host(100, table));
    await lock.run(async () => {
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ pid: 100, started: 't100' });
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('releases the lock when the operation fails, and passes the failure on', async () => {
    const lock = new ProcessLock(file, host(100, table));
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is busy at once, without waiting, while another running process holds it (and does not touch its file)', async () => {
    const holder = new ProcessLock(file, host(200, table));
    const other = new ProcessLock(file, host(100, table));
    let ran = false;
    await holder.run(async () => {
      await expect(other.run(async () => { ran = true; })).rejects.toBeInstanceOf(ProcessLockBusyError);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(200);
    });
    expect(ran).toBe(false);
    await other.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('takes over a lock whose owner is gone (no such process), and one whose id now belongs to a process that started later', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 300, started: 'old' }));
    const lock = new ProcessLock(file, host(100, table));
    await lock.run(async () => undefined);
    table.set(300, 'newer');
    fs.writeFileSync(file, JSON.stringify({ pid: 300, started: 'old' }));
    let ran = false;
    await lock.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('does not take over from a running process whose start time cannot be read', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 200, started: 't200' }));
    const blind: ProcessLockHost = { pid: 100, exists: () => true, readStart: async (p) => (p === 100 ? 't100' : null) };
    await expect(new ProcessLock(file, blind).run(async () => undefined)).rejects.toBeInstanceOf(ProcessLockBusyError);
  });

  it('treats a file being written as busy, and one left unreadable for long as stale', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    const lock = new ProcessLock(file, host(100, table));
    await expect(lock.run(async () => undefined)).rejects.toBeInstanceOf(ProcessLockBusyError);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    await lock.run(async () => undefined);
  });

  it('fails, not guesses, when it cannot tell when this process started', async () => {
    const lock = new ProcessLock(file, { pid: 100, exists: () => true, readStart: async () => null });
    await expect(lock.run(async () => undefined)).rejects.toThrow(/cannot tell when this process/i);
  });

  it('never removes a lock that another process took after this one lost it', async () => {
    const lock = new ProcessLock(file, host(100, table));
    await lock.run(async () => {
      fs.writeFileSync(file, JSON.stringify({ pid: 200, started: 't200' }));
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(200);
  });
});
