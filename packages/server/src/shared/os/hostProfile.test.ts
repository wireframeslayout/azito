import { describe, it, expect } from 'vitest';
import { HOST_PROBE_COMMAND, HostProfileError, assertPosixHost, parseHostProbe, pathDelimiterFor, toHostProfile } from './hostProfile';

describe('toHostProfile', () => {
  it.each([
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ])('narrows %s / %s', (platform, arch) => {
    expect(toHostProfile(platform, arch)).toEqual({ platform, arch });
  });

  it.each([
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
    ['sunos', 'arm64'],
    ['', 'x64'],
    ['constructor', 'x64'],
    ['linux', 'toString'],
  ])('rejects %s / %s as unsupported_host', (platform, arch) => {
    expect(() => toHostProfile(platform, arch)).toThrowError(expect.objectContaining({ name: 'HostProfileError', code: 'unsupported_host' }));
  });
});

describe('parseHostProbe', () => {
  it('reads the output of the probe command', () => {
    expect(parseHostProbe('linux x64\n')).toEqual({ platform: 'linux', arch: 'x64' });
    expect(parseHostProbe('darwin arm64\r\n')).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(parseHostProbe('win32 x64\r\n')).toEqual({ platform: 'win32', arch: 'x64' });
  });

  it('is the same fixed text for sh, cmd and PowerShell', () => {
    expect(HOST_PROBE_COMMAND).toBe(`node -p "process.platform+' '+process.arch"`);
  });

  it('rejects an unknown OS as unsupported_host', () => {
    expect(() => parseHostProbe('freebsd x64')).toThrowError(expect.objectContaining({ code: 'unsupported_host' }));
  });

  it.each(['', '\n', 'linux', 'linux x64 extra', 'node: command not found'])('does not guess from %j', (output) => {
    expect(() => parseHostProbe(output)).toThrow(HostProfileError);
  });
});

describe('assertPosixHost', () => {
  it('lets Linux, macOS and an unrecorded (Unix) agent through', () => {
    expect(() => assertPosixHost({ platform: 'linux', arch: 'x64' }, 'srv')).not.toThrow();
    expect(() => assertPosixHost({ platform: 'darwin', arch: 'arm64' }, 'srv')).not.toThrow();
    expect(() => assertPosixHost(null, 'srv')).not.toThrow();
  });

  it('refuses win32 with a reason, naming the server', () => {
    expect(() => assertPosixHost({ platform: 'win32', arch: 'x64' }, 'agent server "w1"')).toThrowError(
      expect.objectContaining({ code: 'unsupported_os', message: expect.stringContaining('agent server "w1"') }),
    );
  });
});

describe('pathDelimiterFor', () => {
  it('is ";" for Windows and ":" for Unix and for an unrecorded agent', () => {
    expect(pathDelimiterFor({ platform: 'win32', arch: 'x64' })).toBe(';');
    expect(pathDelimiterFor({ platform: 'linux', arch: 'x64' })).toBe(':');
    expect(pathDelimiterFor({ platform: 'darwin', arch: 'arm64' })).toBe(':');
    expect(pathDelimiterFor(null)).toBe(':');
  });
});
