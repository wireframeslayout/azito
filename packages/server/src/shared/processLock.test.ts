import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import net from 'net';
import { ProcessLock, ProcessLockBusyError, ProcessLockForeignHolderError, misaoRootLockEndpoint } from './processLock';

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
    const lock = new ProcessLock(endpoint);
    expect(await lock.run(async () => 'ok')).toBe('ok');
    expect(await lock.run(async () => 'again')).toBe('again');
  });

  it('releases the lock when the operation fails, and passes the failure on', async () => {
    const lock = new ProcessLock(endpoint);
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run(async () => 'free')).toBe('free');
  });

  it('is busy at once, without waiting, while it is held, and names the holder', async () => {
    const holder = new ProcessLock(endpoint);
    const other = new ProcessLock(endpoint, async () => ({ state: 'same-user', pid: 4242 }));
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
    const take = (pid: number): Promise<'in' | 'busy'> => new ProcessLock(endpoint).run(async () => {
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

describe("ProcessLock when the holder is not this user's", () => {
  let dir: string;
  let endpoint: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azlock-'));
    endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\azito-lock-test-${path.basename(dir)}` : path.join(dir, 'l.sock');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("stops with the reason, not as 'busy', when the OS says another user's process holds it (a possible pre-emption)", async () => {
    let asked: string | undefined;
    const other = new ProcessLock(endpoint, async (e) => { asked = e; return { state: 'other-user', pid: 777, ownerSid: 'S-1-5-21-1-2-3-1001' }; });
    await new ProcessLock(endpoint).run(async () => {
      const refused = await other.run(async () => 'in').catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ProcessLockForeignHolderError);
      expect(refused).not.toBeInstanceOf(ProcessLockBusyError);
      expect((refused as Error).message).toMatch(/another user \(process 777, owner S-1-5-21-1-2-3-1001\).*may have taken the name first/);
    });
    expect(asked).toBe(endpoint);
  });

  it('stops with the reason when the holder cannot be identified (it is not taken for this user\'s)', async () => {
    const other = new ProcessLock(endpoint, async () => ({ state: 'unknown', reason: 'the owner of process 5 could not be read' }));
    await new ProcessLock(endpoint).run(async () => {
      await expect(other.run(async () => 'in')).rejects.toThrow(/could not be identified as this user's \(the owner of process 5 could not be read\)/);
    });
  });

  it('does not ask who holds it while it is free', async () => {
    let asked = false;
    const lock = new ProcessLock(endpoint, async () => { asked = true; return { state: 'same-user', pid: 1 }; });
    expect(await lock.run(async () => 'in')).toBe('in');
    expect(asked).toBe(false);
  });
});

describe('ProcessLock with a client that never reads', () => {
  it('does not keep the release waiting: the answer to a connection is cut off, and release destroys every connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azlock-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\azito-lock-test-${path.basename(dir)}` : path.join(dir, 'l.sock');
    const sockets: net.Socket[] = [];
    try {
      const started = Date.now();
      await new ProcessLock(endpoint).run(async () => {
        for (let i = 0; i < 3; i += 1) {
          const client = net.connect(endpoint);
          client.pause(); // connected, and never reads
          client.on('error', () => undefined);
          sockets.push(client);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(Date.now() - started).toBeLessThan(5000);
      // and the lock is free again at once
      expect(await new ProcessLock(endpoint).run(async () => 'free')).toBe('free');
    } finally {
      for (const client of sockets) client.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('misaoRootLockEndpoint', () => {
  it('is one pipe per folder: the same for another letter case or a trailing separator, different for another folder', () => {
    const key = 'a'.repeat(64);
    const a = misaoRootLockEndpoint('C:\\Users\\Me\\.azito\\misao', key);
    expect(a).toMatch(/^\\\\\.\\pipe\\azito-lock-[0-9a-f]{32}$/);
    expect(misaoRootLockEndpoint('c:\\users\\me\\.azito\\MISAO\\', key)).toBe(a);
    expect(misaoRootLockEndpoint('C:\\Users\\Other\\.azito\\misao', key)).not.toBe(a);
    // Without the secret key the name is another one: nobody who cannot read the key can name (hence take first) the pipe.
    expect(misaoRootLockEndpoint('C:\\Users\\Me\\.azito\\misao', 'b'.repeat(64))).not.toBe(a);
  });
});
