import { describe, expect, it } from 'vitest';
import { MISAO_TARGETS, misaoTargetFor } from './MisaoBundle';

describe('misaoTargetFor', () => {
  it.each([
    ['linux', 'x64', 'x86_64-unknown-linux-musl'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
  ])('maps %s/%s to %s', (platform, arch, target) => {
    expect(misaoTargetFor(platform, arch)).toBe(target);
    expect(MISAO_TARGETS).toContain(target);
  });

  it.each([
    ['win32', 'x64'],
    ['linux', 'riscv64'],
    ['linux', 'ia32'],
    ['freebsd', 'x64'],
    ['darwin', 'ppc64'],
  ])('refuses %s/%s instead of falling back to another build', (platform, arch) => {
    expect(() => misaoTargetFor(platform, arch)).toThrowError(expect.objectContaining({ code: 'unsupported_host' }));
  });

  it('does not treat an inherited property name as a platform', () => {
    expect(() => misaoTargetFor('constructor', 'x64')).toThrow();
    expect(() => misaoTargetFor('linux', 'toString')).toThrow();
  });
});
