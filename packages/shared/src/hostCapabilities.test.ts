import { describe, it, expect } from 'vitest';
import { HOST_FEATURES, hostFeatureSupport } from './hostCapabilities';

describe('hostFeatureSupport', () => {
  it('every feature is available on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const feature of HOST_FEATURES) expect(hostFeatureSupport({ platform }, feature)).toEqual({ available: true });
    }
  });

  it('a host whose OS is not recorded is a Unix one: everything is available', () => {
    for (const feature of HOST_FEATURES) {
      expect(hostFeatureSupport(null, feature)).toEqual({ available: true });
      expect(hostFeatureSupport(undefined, feature)).toEqual({ available: true });
    }
  });

  it('names the issue that brings each feature to Windows', () => {
    const win32 = { platform: 'win32' as const };
    expect(hostFeatureSupport(win32, 'browserRuntime')).toEqual({ available: false, issue: 500 });
    expect(hostFeatureSupport(win32, 'isolation')).toEqual({ available: false, issue: 464 });
    expect(hostFeatureSupport(win32, 'codeDistribution')).toEqual({ available: false, issue: 464 });
  });

  it('tmux is unavailable on Windows for good (no issue)', () => {
    expect(hostFeatureSupport({ platform: 'win32' }, 'tmux')).toEqual({ available: false, issue: null });
  });
});
