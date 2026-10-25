import { describe, it, expect } from 'vitest';
import { assertHostFeature, workerStartsAsProgram } from './hostFeature';
import { HostProfileError } from './hostProfile';

describe('assertHostFeature', () => {
  it('refuses a feature a Windows host does not have yet, as unsupported_os that names the tracking issue', () => {
    expect(() => assertHostFeature({ platform: 'win32' }, 'taskExecution', 'Running a task')).toThrowError(HostProfileError);
    expect(() => assertHostFeature({ platform: 'win32' }, 'taskExecution', 'Running a task')).toThrowError(expect.objectContaining({
      code: 'unsupported_os',
      message: 'Running a task is not available on Windows hosts yet (tracked in #371).',
    }));
  });

  it('leaves out the issue for a feature that never comes to the OS', () => {
    expect(() => assertHostFeature({ platform: 'win32' }, 'tmux', 'Installing tmux')).toThrow('Installing tmux is not available on Windows hosts.');
  });

  it('passes on Unix hosts and on a host whose OS is not recorded', () => {
    expect(() => assertHostFeature({ platform: 'linux' }, 'taskExecution', 'Running a task')).not.toThrow();
    expect(() => assertHostFeature({ platform: 'darwin' }, 'harness', 'Installing the harness')).not.toThrow();
    expect(() => assertHostFeature(null, 'taskExecution', 'Running a task')).not.toThrow();
    expect(() => assertHostFeature(undefined, 'taskExecution', 'Running a task')).not.toThrow();
  });
});

describe('workerStartsAsProgram', () => {
  it('is true for a Windows host only: a Unix host, and one whose OS is not recorded, type a line into the shell', () => {
    expect(workerStartsAsProgram({ platform: 'win32' })).toBe(true);
    expect(workerStartsAsProgram({ platform: 'linux' })).toBe(false);
    expect(workerStartsAsProgram({ platform: 'darwin' })).toBe(false);
    expect(workerStartsAsProgram(null)).toBe(false);
    expect(workerStartsAsProgram(undefined)).toBe(false);
  });
});
