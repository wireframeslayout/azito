import { describe, it, expect } from 'vitest';
import { describeHostProfile } from './hostProfile';

describe('describeHostProfile', () => {
  it('names the OS and keeps the architecture', () => {
    expect(describeHostProfile({ platform: 'linux', arch: 'x64' })).toEqual({ osKey: 'linux', arch: 'x64' });
    expect(describeHostProfile({ platform: 'darwin', arch: 'arm64' })).toEqual({ osKey: 'macos', arch: 'arm64' });
    expect(describeHostProfile({ platform: 'win32', arch: 'x64' })).toEqual({ osKey: 'windows', arch: 'x64' });
  });

  it('is unknown (null) when the host is not recorded', () => {
    expect(describeHostProfile(null)).toBeNull();
    expect(describeHostProfile(undefined)).toBeNull();
  });

  it('is unknown for a value that is not a profile, never a guess', () => {
    expect(describeHostProfile({ platform: 'freebsd', arch: 'x64' })).toBeNull();
    expect(describeHostProfile({ platform: 'constructor', arch: 'x64' })).toBeNull();
    expect(describeHostProfile({ platform: 'linux' })).toBeNull();
    expect(describeHostProfile('linux x64')).toBeNull();
  });
});
