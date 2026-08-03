import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import { restartCommand, isServiceManager } from '../serviceControl';

describe('serviceControl', () => {
  it('restarts through systemctl under systemd', () => {
    expect(restartCommand('systemd')).toEqual({ file: 'systemctl', args: ['--user', 'restart', 'azito'] });
  });

  it('restarts through launchctl kickstart in the current user GUI domain under launchd', () => {
    // launchd has no `restart`; kickstart -k is the equivalent, and it needs
    // the service target to name the domain the LaunchAgent was loaded into.
    vi.spyOn(os, 'userInfo').mockReturnValue({ uid: 501 } as ReturnType<typeof os.userInfo>);
    expect(restartCommand('launchd')).toEqual({
      file: 'launchctl',
      args: ['kickstart', '-k', 'gui/501/com.azito.hub'],
    });
    vi.restoreAllMocks();
  });

  it('rejects anything that is not a known service manager', () => {
    expect(isServiceManager('systemd')).toBe(true);
    expect(isServiceManager('launchd')).toBe(true);
    expect(isServiceManager('source')).toBe(false);
    expect(isServiceManager('')).toBe(false);
  });
});
