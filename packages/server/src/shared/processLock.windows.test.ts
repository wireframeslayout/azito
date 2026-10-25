import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretFileGuard, type SecretFileGuard } from './os/secretFileGuard';
import { FileLock, ProcessLockBusyError } from './processLock';

/**
 * The exclusive file lock on a real Windows, between real processes: the flag libuv opens the file with (sharing mode 0) really keeps
 * a second process (or a second open in the same one) out, the OS frees it when the holder is killed, one of several takers that come at
 * once gets it, a refused taker is told who holds it, and a folder that is not owner-only is refused.
 */
let guard: SecretFileGuard;
const PACKAGE_DIR = path.resolve(__dirname, '..', '..');
const LOCK_MODULE = pathToFileURL(path.join(__dirname, 'processLock.ts')).href;
const GUARD_MODULE = pathToFileURL(path.join(__dirname, 'os', 'secretFileGuard.ts')).href;

let dir: string;
let root: string;
let children: ChildProcess[];

const lockIn = (folder: string): FileLock => new FileLock(path.join(folder, '.operation.lock'), path.join(folder, '.operation.owner'), guard);
const exited = (child: ChildProcess): Promise<void> => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });

/** A process that takes the lock with the real FileLock and holds it until it is killed; resolves 'held' or 'busy' once it knows. */
function startTaker(folder: string): Promise<{ child: ChildProcess; result: 'held' | 'busy' }> {
  const script = path.join(dir, `taker-${children.length}.mjs`);
  fs.writeFileSync(script, [
    `import { FileLock, ProcessLockBusyError } from ${JSON.stringify(LOCK_MODULE)};`,
    `import { createSecretFileGuard } from ${JSON.stringify(GUARD_MODULE)};`,
    'const folder = process.argv[2];',
    "const lock = new FileLock(folder + '\\\\.operation.lock', folder + '\\\\.operation.owner', createSecretFileGuard('win32', process.env));",
    'try {',
    "  await lock.run(async () => { console.log('held'); await new Promise(() => {}); });",
    '} catch (err) {',
    "  if (err instanceof ProcessLockBusyError) { console.log('busy'); process.exit(0); }",
    '  console.error(err); process.exit(2);',
    '}',
  ].join('\n'));
  const child = spawn(process.execPath, ['--import', 'tsx', script, folder], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
      if (out.includes('held')) resolve({ child, result: 'held' });
      else if (out.includes('busy')) resolve({ child, result: 'busy' });
    });
    child.once('exit', (code) => reject(new Error(`the taker exited with ${code} before it knew: ${out}`)));
  });
}

describe.skipIf(process.platform !== 'win32')('FileLock (UV_FS_O_EXLOCK) between processes on Windows', () => {
  beforeEach(() => {
    guard = createSecretFileGuard('win32', process.env);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-filelock-'));
    root = path.join(dir, 'misao');
    guard.ensureProtectedDir(root);
    children = [];
  });

  afterEach(async () => {
    for (const child of children) {
      child.kill();
      await exited(child);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('keeps a second process out while the first holds it (naming the holder), and lets the next one in as soon as the holder is killed', async () => {
    const holder = await startTaker(root);
    expect(holder.result).toBe('held');
    const refused = await lockIn(root).run(async () => 'in').catch((err: unknown) => err);
    expect(refused, 'the second open must be refused while the first process holds the file').toBeInstanceOf(ProcessLockBusyError);
    expect((refused as ProcessLockBusyError).owner?.pid).toBe(holder.child.pid);
    holder.child.kill('SIGKILL');
    await exited(holder.child);
    expect(await lockIn(root).run(async () => 'in')).toBe('in');
    expect(fs.existsSync(path.join(root, '.operation.owner'))).toBe(false);
  }, 120_000);

  it('keeps a second holder out inside one process too, and frees the lock when the operation fails', async () => {
    const lock = lockIn(root);
    await lock.run(async () => {
      await expect(lockIn(root).run(async () => 'in')).rejects.toBeInstanceOf(ProcessLockBusyError);
    });
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run(async () => 'free')).toBe('free');
  });

  it('says the holder is unknown when it left nothing to read', async () => {
    const lock = lockIn(root);
    await lock.run(async () => {
      fs.rmSync(path.join(root, '.operation.owner'), { force: true });
      const refused = await lockIn(root).run(async () => 'in').catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ProcessLockBusyError);
      expect((refused as ProcessLockBusyError).owner).toBeUndefined();
    });
  });

  it('lets exactly one of three takers that come at the same moment in (two processes and this one)', async () => {
    const [a, b, mine] = await Promise.all([
      startTaker(root),
      startTaker(root),
      lockIn(root).run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return 'in' as const;
      }).catch((err: unknown) => (err instanceof ProcessLockBusyError ? ('busy' as const) : Promise.reject(err))),
    ]);
    const results = [a.result === 'held' ? 'in' : 'busy', b.result === 'held' ? 'in' : 'busy', mine];
    expect(results.filter((r) => r === 'in')).toHaveLength(1);
  }, 120_000);

  it('refuses a folder that is not owner-only, before it opens anything (so that nobody else could have made or opened the file first)', async () => {
    const open = path.join(dir, 'open');
    fs.mkdirSync(open); // inherits the ACL of the temp folder: not a protected, owner-only one
    await expect(lockIn(open).run(async () => 'in')).rejects.toThrow(/is not private to this user/);
    expect(fs.existsSync(path.join(open, '.operation.lock'))).toBe(false);
  });

  it('makes a missing folder owner-only and its lock file with it', async () => {
    const fresh = path.join(dir, 'fresh', 'misao');
    expect(await lockIn(fresh).run(async () => 'in')).toBe('in');
    expect(guard.inspect(fresh, 'dir')).toEqual({ ok: true });
    expect(guard.inspect(path.join(fresh, '.operation.lock'), 'file')).toEqual({ ok: true });
  });
});
