import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { ProcessLock, ProcessLockBusyError } from '../../../shared/processLock';
import { createPipeHolderCheck } from './misaoPipeHolder';

/** The holder check on a real Windows: the process Windows says serves the pipe, and whose it is. A second user cannot be made on a runner, so "other user" is the unit test's. */
describe.skipIf(process.platform !== 'win32')('the holder check of the lock pipe (Windows)', () => {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

  it('finds this very process, as this user\'s, for a pipe this process serves', async () => {
    const endpoint = `\\\\.\\pipe\\azito-lock-test-${crypto.randomBytes(6).toString('hex')}`;
    await new ProcessLock(endpoint).run(async () => {
      expect(await createPipeHolderCheck(systemRoot)(endpoint)).toEqual({ state: 'same-user', pid: process.pid });
    });
  }, 60_000);

  it('turns an EADDRINUSE into a busy that names the holder (the pid Windows reports) when this user holds the lock', async () => {
    const endpoint = `\\\\.\\pipe\\azito-lock-test-${crypto.randomBytes(6).toString('hex')}`;
    await new ProcessLock(endpoint).run(async () => {
      const refused = await new ProcessLock(endpoint, createPipeHolderCheck(systemRoot)).run(async () => 'in').catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ProcessLockBusyError);
      expect((refused as ProcessLockBusyError).ownerPid).toBe(process.pid);
    });
  }, 60_000);

  it('is unknown (not "mine") for a pipe nobody serves', async () => {
    const verdict = await createPipeHolderCheck(systemRoot)(`\\\\.\\pipe\\azito-lock-test-none-${crypto.randomBytes(6).toString('hex')}`);
    expect(verdict.state).toBe('unknown');
  }, 60_000);
});
