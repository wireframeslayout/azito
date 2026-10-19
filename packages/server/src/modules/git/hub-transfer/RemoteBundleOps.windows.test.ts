import { describe, expect, it } from 'vitest';
import { RemoteBundleOps } from './RemoteBundleOps';

describe('RemoteBundleOps.assertSupported', () => {
  const ops = new RemoteBundleOps();

  it('refuses a win32 server with unsupported_os (every operation is a POSIX shell command)', () => {
    expect(() => ops.assertSupported({ hostProfile: { platform: 'win32', arch: 'x64' } })).toThrow(expect.objectContaining({ code: 'unsupported_os' }));
  });

  it('accepts Linux, macOS and a server with no recorded OS (a Unix agent from before it was kept)', () => {
    expect(() => ops.assertSupported({ hostProfile: { platform: 'linux', arch: 'x64' } })).not.toThrow();
    expect(() => ops.assertSupported({ hostProfile: { platform: 'darwin', arch: 'arm64' } })).not.toThrow();
    expect(() => ops.assertSupported({ hostProfile: null })).not.toThrow();
  });
});
