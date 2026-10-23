import { describe, it, expect } from 'vitest';
import { assertGitSupported, HostProfileError } from './hostProfile';

describe('assertGitSupported', () => {
  it('allows Linux, macOS and a host whose OS is not recorded', () => {
    expect(() => assertGitSupported({ platform: 'linux', arch: 'x64' }, 'server "a"')).not.toThrow();
    expect(() => assertGitSupported({ platform: 'darwin', arch: 'arm64' }, 'server "a"')).not.toThrow();
    expect(() => assertGitSupported(null, 'server "a"')).not.toThrow();
  });

  it('refuses a Windows host with an unsupported_os reason', () => {
    let caught: unknown;
    try {
      assertGitSupported({ platform: 'win32', arch: 'x64' }, 'server "win"');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostProfileError);
    expect((caught as HostProfileError).code).toBe('unsupported_os');
    expect((caught as HostProfileError).message).toContain('server "win"');
    expect((caught as HostProfileError).message).toContain('#370');
  });
});
