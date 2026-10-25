import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceManager } from '../serviceManager';

const calls: Array<{ file: string; args: string[]; options: { timeout?: number; killSignal?: string } }> = [];
let failWith: (Error & { killed?: boolean }) | undefined;

vi.mock('child_process', () => ({
  // promisify(execFile) needs a callback-style function to wrap.
  execFile: vi.fn((file: string, args: string[], options: { timeout?: number; killSignal?: string }, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    calls.push({ file, args, options });
    if (failWith && file !== 'tar') return cb(failWith, { stdout: '', stderr: '' });
    cb(null, { stdout: file === 'tar' && args[0] === 'tf' ? 'a/b\n' : '', stderr: '' });
  }),
}));

import { createUnixUpdateBackend } from '../unixUpdateBackend';

describe('the Unix update backend\'s extract step', () => {
  beforeEach(() => {
    calls.length = 0;
    failWith = undefined;
  });

  const extract = (platform: NodeJS.Platform): Promise<void> => createUnixUpdateBackend('/tmp/azito-hub-test-dir', {} as ServiceManager, platform).extract('/tmp/a.tar.gz', '/tmp/azito-hub-test-dir/v1');

  it('gives every child it runs (the listing, the unpacking, xattr) a finite time limit and kills it with SIGKILL when it is over', async () => {
    await extract('darwin');
    expect(calls.map((c) => c.file)).toEqual(['tar', 'tar', 'xattr']);
    for (const call of calls) {
      expect(call.options.timeout).toBeGreaterThan(0);
      expect(Number.isFinite(call.options.timeout)).toBe(true);
      expect(call.options.killSignal).toBe('SIGKILL');
    }
  });

  it('fails the step when xattr runs out of time, and lets an ordinary xattr failure pass (it is best effort)', async () => {
    failWith = Object.assign(new Error('xattr: No such attribute'), { killed: false });
    await expect(extract('darwin')).resolves.toBeUndefined();
    failWith = Object.assign(new Error('Command failed: timed out'), { killed: true });
    await expect(extract('darwin')).rejects.toThrow(/timed out/);
  });

  it('does not run xattr on Linux', async () => {
    await extract('linux');
    expect(calls.map((c) => c.file)).toEqual(['tar', 'tar']);
  });
});
