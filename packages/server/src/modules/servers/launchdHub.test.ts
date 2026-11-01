import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { isLaunchdHub } from './launchdHub';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('isLaunchdHub', () => {
  const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  beforeEach(() => {
    Object.defineProperty(process, 'getuid', { configurable: true, writable: true, value: () => 501 });
    vi.mocked(execFileSync).mockReset();
  });
  afterEach(() => {
    if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid);
    else Reflect.deleteProperty(process, 'getuid');
  });
  it('compares the PID of the user-domain job', () => {
    vi.mocked(execFileSync).mockReturnValue('state = running\n\tpid = 123\n' as never);
    expect(isLaunchdHub('darwin', 123)).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('/bin/launchctl', ['print', 'user/501/com.azito.hub'], expect.any(Object));
    expect(isLaunchdHub('darwin', 124)).toBe(false);
    expect(isLaunchdHub('linux', 123)).toBe(false);
  });
  it('does not diagnose when the job cannot be inspected', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('missing'); });
    expect(isLaunchdHub('darwin', 123)).toBe(false);
  });
  it('does not inspect the job when getuid is unavailable', () => {
    Reflect.deleteProperty(process, 'getuid');
    expect(isLaunchdHub('darwin', 123)).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
