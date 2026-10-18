import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MISAO_RELEASE_FILE_NAMES } from '../../servers/transport/agentMisaoSocket';
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

// scripts/ is outside this package's tsc rootDir (it is built by tsx), so the build script is read as text.
const BUILD_SCRIPT = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/misaoAssets.ts'), 'utf-8');

describe('the build script and the runtime agree on what a release is made of', () => {
  it('lists the same release files (the build script stages them, the agent accepts exactly these as uploads)', () => {
    const listed = /MISAO_RELEASE_FILES = \[([^\]]+)\] as const/.exec(BUILD_SCRIPT)?.[1];
    expect(listed).toBeDefined();
    const names = [...listed!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...MISAO_RELEASE_FILE_NAMES].sort());
  });

  it('pins an archive for every target the runtime can pick, and no other', () => {
    const archives = [...BUILD_SCRIPT.matchAll(/'misao-[0-9.]+-([a-z0-9_-]+)\.tar\.gz':/g)].map((m) => m[1]);
    expect(archives.sort()).toEqual([...MISAO_TARGETS].sort());
  });
});
