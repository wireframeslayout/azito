import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
import { LocalTransport } from './LocalTransport';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { testLocalHost } from '../../../shared/os/testing/testLocalHost';

function make(bin: string) {
  return new LocalTransport({ bin, baseArgs: [] }, 'http://hub', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
}

describe('local mux failures', () => {
  it.skipIf(process.platform === 'win32')('does not retain the command or environment in an execution error', async () => {
    const error = await make('/bin/false').execMux({ kind: 'tmux', args: ['new-window', '-e', 'ARBITRARY=secret with spaces'] }).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: 'tmux new-window failed: exit 1', code: 1 });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(String(error)).not.toContain('ARBITRARY');
  });
  it('retains ENOENT for missing binary classification', async () => {
    await expect(make('/missing-azito-tmux-test').execMux({ kind: 'tmux', args: ['new-window'] })).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.skipIf(process.platform === 'win32')('classifies a timeout without exposing arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'azito-mux-timeout-'));
    try {
      const script = join(dir, 'tmux');
      await writeFile(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
      const error = await make(script).execMux({ kind: 'tmux', args: ['new-window', '-e', 'CUSTOM=secret'] }).catch((err: unknown) => err);
      expect(String(error)).toContain('timed out');
      expect(String(error)).not.toContain('secret');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 10000);

});
