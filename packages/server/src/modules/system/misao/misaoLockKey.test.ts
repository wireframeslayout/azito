import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretFileGuard, type SecretFileGuard } from '../../../shared/os/secretFileGuard';
import { LOCK_KEY_FILE, readOrCreateLockKey } from './misaoLockKey';
import { createMisaoRootLock } from './misaoRootLock';

/** The guard with some methods replaced (a spread would lose the methods of the class). */
const withOverrides = (guard: SecretFileGuard, overrides: Partial<SecretFileGuard>): SecretFileGuard => Object.assign(Object.create(guard) as SecretFileGuard, overrides);

describe('the misao folder\'s lock key', () => {
  let dir: string;
  let root: string;
  const guard = createSecretFileGuard(process.platform, process.env);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azkey-'));
    root = path.join(dir, 'misao'); // does not exist yet: the first operation of an install makes it
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is made once, through the secret-file guard, and is the same for every later reader', () => {
    const key = readOrCreateLockKey(root, guard);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readOrCreateLockKey(root, guard)).toBe(key);
    expect(guard.inspect(path.join(root, LOCK_KEY_FILE), 'file')).toEqual({ ok: true });
    // no leftover from the atomic creation
    expect(fs.readdirSync(root)).toEqual([LOCK_KEY_FILE]);
  });

  it('is written by the guard (owner-only before any content), never by a plain write', () => {
    const written: string[] = [];
    const spy: SecretFileGuard = withOverrides(guard, { writeSecretFile: (file, content) => { written.push(file); guard.writeSecretFile(file, content); } });
    readOrCreateLockKey(root, spy);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(LOCK_KEY_FILE);
  });

  it('fails with the reason when the file is not private to this user, instead of going on without a secret', () => {
    readOrCreateLockKey(root, guard);
    const loose: SecretFileGuard = withOverrides(guard, { inspect: () => ({ ok: false, summary: 'other users can read it', fix: 'Fix the permissions.' }) });
    expect(() => readOrCreateLockKey(root, loose)).toThrow(/not private to this user \(other users can read it\)\. Fix the permissions\./);
  });

  it('fails when the file does not hold a key', () => {
    readOrCreateLockKey(root, guard);
    fs.writeFileSync(path.join(root, LOCK_KEY_FILE), 'garbage');
    expect(() => readOrCreateLockKey(root, guard)).toThrow(/does not hold a lock key/);
  });

  it('gives another endpoint for another key: a lock taken with one key is not held against a taker with the other', async () => {
    const lockA = createMisaoRootLock(root, guard, 'C:\\Windows');
    let other: string | undefined;
    await lockA.run(async () => {
      // A second taker with the SAME key is refused ...
      await expect(createMisaoRootLock(root, guard, 'C:\\Windows').run(async () => 'in')).rejects.toThrow(/azito-lock/);
      // ... and one that cannot read the key cannot even name the lock.
      const broken: SecretFileGuard = withOverrides(guard, { inspect: () => ({ ok: false, summary: 'x', fix: 'y' }) });
      other = await createMisaoRootLock(root, broken, 'C:\\Windows').run(async () => 'in').catch((err: Error) => err.message);
    });
    expect(other).toMatch(/not private to this user/);
  });
});
