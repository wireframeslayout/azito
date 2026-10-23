import { describe, expect, it } from 'vitest';
import { createMisaoServiceManager, createServiceManager, type ServiceHost } from '../createServiceManager';
import { HUB_SERVICE, type CommandRunner } from '../serviceManager';

const run: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' });
const host = (platform: NodeJS.Platform): ServiceHost => ({ platform, homeDir: platform === 'win32' ? 'C:\\Users\\u' : '/h', uid: platform === 'win32' ? -1 : 501, tmpDir: platform === 'win32' ? 'C:\\Temp' : '/tmp', systemRoot: platform === 'win32' ? 'C:\\Windows' : undefined });

describe('createServiceManager', () => {
  it('picks systemd on Linux, launchd on macOS and the Task Scheduler on Windows', () => {
    expect(createServiceManager(host('linux'), HUB_SERVICE, run)).toMatchObject({ manager: { kind: 'systemd' } });
    expect(createServiceManager(host('darwin'), HUB_SERVICE, run)).toMatchObject({ manager: { kind: 'launchd' } });
    expect(createServiceManager(host('win32'), HUB_SERVICE, run)).toMatchObject({ manager: { kind: 'taskscheduler', templateName: undefined } });
  });

  it('refuses an OS AZITO does not know with unsupported_host, instead of falling back to another manager', () => {
    expect(createServiceManager(host('freebsd'), HUB_SERVICE, run)).toMatchObject({ error: { code: 'unsupported_host', message: expect.stringContaining('freebsd') } });
  });
});

describe('createMisaoServiceManager', () => {
  it('is the same manager as the hub gets on Linux and macOS', () => {
    expect(createMisaoServiceManager(host('linux'), run)).toMatchObject({ manager: { kind: 'systemd' } });
    expect(createMisaoServiceManager(host('darwin'), run)).toMatchObject({ manager: { kind: 'launchd' } });
  });

  it('keeps the hub\'s own misao unsupported on Windows until B3b, with the reason', () => {
    expect(createMisaoServiceManager(host('win32'), run)).toMatchObject({ error: { code: 'unsupported_os', message: expect.stringContaining('misao') } });
  });
});
