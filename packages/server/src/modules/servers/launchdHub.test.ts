import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { isLaunchdHub } from './launchdHub';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('isLaunchdHub', () => {
  it('compares the PID of the user-domain job', () => {
    vi.mocked(execFileSync).mockReturnValue('state = running\n\tpid = 123\n' as never);
    expect(isLaunchdHub('darwin', 123)).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('/bin/launchctl', ['print', `user/${process.getuid!()}/com.azito.hub`], expect.any(Object));
    expect(isLaunchdHub('darwin', 124)).toBe(false);
    expect(isLaunchdHub('linux', 123)).toBe(false);
  });
  it('does not diagnose when the job cannot be inspected', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('missing'); });
    expect(isLaunchdHub('darwin', 123)).toBe(false);
  });
});
