import { describe, it, expect, vi } from 'vitest';
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
import { LocalTransport } from './LocalTransport';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { testLocalHost } from '../../../shared/os/testing/testLocalHost';

function make(bin: string) {
  return new LocalTransport({ bin, baseArgs: [] }, 'http://hub', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
}

describe('local mux failures', () => {
  it('does not retain the command or environment in an execution error', async () => {
    const error = await make('/bin/false').execMux({ kind: 'tmux', args: ['new-window', '-e', 'ARBITRARY=secret with spaces'] }).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: 'tmux new-window failed: exit 1', code: 1 });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(String(error)).not.toContain('ARBITRARY');
  });
  it('retains ENOENT for missing binary classification', async () => {
    await expect(make('/missing-azito-tmux-test').execMux({ kind: 'tmux', args: ['new-window'] })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
