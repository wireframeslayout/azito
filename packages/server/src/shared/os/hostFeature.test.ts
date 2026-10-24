import { describe, it, expect } from 'vitest';
import { assertHostFeature, workerLineDialect } from './hostFeature';
import { HostProfileError } from './hostProfile';

describe('assertHostFeature', () => {
  it('refuses a feature a Windows host does not have yet, as unsupported_os that names the tracking issue', () => {
    expect(() => assertHostFeature({ platform: 'win32' }, 'workerLaunch', 'Launching an agent')).toThrowError(HostProfileError);
    expect(() => assertHostFeature({ platform: 'win32' }, 'workerLaunch', 'Launching an agent')).toThrowError(expect.objectContaining({
      code: 'unsupported_os',
      message: 'Launching an agent is not available on Windows hosts yet (tracked in #371).',
    }));
  });

  it('leaves out the issue for a feature that never comes to the OS', () => {
    expect(() => assertHostFeature({ platform: 'win32' }, 'tmux', 'Installing tmux')).toThrow('Installing tmux is not available on Windows hosts.');
  });

  it('workerLineDialect refuses before building any line on Windows, and gives the host dialect elsewhere', () => {
    expect(() => workerLineDialect({ platform: 'win32' }, 'Resuming a worker')).toThrowError(expect.objectContaining({ code: 'unsupported_os' }));
    expect(workerLineDialect({ platform: 'linux' }, 'Resuming a worker').changeDirectory('/tmp')).toContain('/tmp');
    expect(workerLineDialect(null, 'Resuming a worker').changeDirectory('/tmp')).toContain('/tmp');
  });

  it('passes on Unix hosts and on a host whose OS is not recorded', () => {
    expect(() => assertHostFeature({ platform: 'linux' }, 'taskExecution', 'Running a task')).not.toThrow();
    expect(() => assertHostFeature({ platform: 'darwin' }, 'workerLaunch', 'Launching an agent')).not.toThrow();
    expect(() => assertHostFeature(null, 'taskExecution', 'Running a task')).not.toThrow();
    expect(() => assertHostFeature(undefined, 'taskExecution', 'Running a task')).not.toThrow();
  });
});
