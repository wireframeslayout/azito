import os from 'os';
import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { LocalTransport } from './LocalTransport';
import { TaskTempFiles } from '../../../shared/os/taskTempFiles';

const rt = { bin: 'tmux', baseArgs: [] } as never;
const make = (platform: 'linux' | 'darwin' | 'win32') => new LocalTransport(rt, 'http://hub', os.homedir(), new TaskTempFiles('/tmp', 'linux'), { platform, arch: 'x64' });

describe('LocalTransport host profile', () => {
  it('keeps running sh commands on a Unix hub', async () => {
    const result = await make(process.platform === 'darwin' ? 'darwin' : 'linux').exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('refuses exec(string) when the hub itself is Windows, with a reason, without running anything', async () => {
    await expect(make('win32').exec('echo hello')).rejects.toMatchObject({
      code: 'unsupported_os',
      message: expect.stringContaining('/bin/sh'),
    });
  });

  it('exposes the profile it was given', () => {
    expect(make('darwin').hostProfile).toEqual({ platform: 'darwin', arch: 'x64' });
  });
});
