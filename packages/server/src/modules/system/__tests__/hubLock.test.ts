import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessLock } from '../../../shared/processLock';
import { hubLockEndpoint, underHubLock } from '../hubLock';

describe('hubLockEndpoint', () => {
  it('is a named pipe, the same for the same folder and key whatever the letter case or a trailing separator, and different otherwise', () => {
    const key = 'a'.repeat(64);
    const endpoint = hubLockEndpoint('C:\\Users\\me\\.azito\\hub', key);
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\azito-hub-lock-[0-9a-f]{32}$/);
    expect(hubLockEndpoint('c:\\users\\ME\\.azito\\hub\\', key)).toBe(endpoint);
    expect(hubLockEndpoint('C:\\Users\\other\\.azito\\hub', key)).not.toBe(endpoint);
    expect(hubLockEndpoint('C:\\Users\\me\\.azito\\hub', 'b'.repeat(64))).not.toBe(endpoint);
  });

  it('is not the name of a misao folder\'s lock', () => {
    expect(hubLockEndpoint('C:\\x', 'k')).not.toContain('azito-lock-');
  });
});

describe('underHubLock', () => {
  let dir: string;
  let lock: ProcessLock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-hublock-'));
    // The very mechanism: a named pipe on Windows, a unix socket path where there are none.
    lock = new ProcessLock(process.platform === 'win32' ? `\\\\.\\pipe\\azito-hublock-test-${path.basename(dir)}` : path.join(dir, 'lock.sock'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the operation and gives its result back', async () => {
    await expect(underHubLock(lock, async () => 42)).resolves.toBe(42);
  });

  it('refuses a second taker at once with a reason that says nothing was changed, and the operation never runs', async () => {
    let ran = false;
    await underHubLock(lock, async () => {
      await expect(underHubLock(lock, async () => { ran = true; })).rejects.toThrow(/Another AZITO hub operation .*Nothing was changed/);
    });
    expect(ran).toBe(false);
  });

  it('lets the next one in once the first is done', async () => {
    await underHubLock(lock, async () => undefined);
    await expect(underHubLock(lock, async () => 'again')).resolves.toBe('again');
  });

  it('passes an operation\'s own failure through untouched', async () => {
    await expect(underHubLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
