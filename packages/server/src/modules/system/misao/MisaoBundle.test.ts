import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MISAO_RELEASE_FILE_NAMES } from '../../servers/transport/agentMisaoSocket';
import os from 'os';
import { MISAO_TARGETS, misaoFileName, misaoTargetFor, readMisaoBundle } from './MisaoBundle';
import { writeHubBundle } from './misaoBundleFixture';

describe('misaoTargetFor', () => {
  it.each([
    ['linux', 'x64', 'x86_64-unknown-linux-musl'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
  ])('maps %s/%s to %s', (platform, arch, target) => {
    expect(misaoTargetFor(platform, arch)).toBe(target);
    expect(MISAO_TARGETS).toContain(target);
  });

  it.each([
    ['win32', 'arm64'],
    ['win32', 'ia32'],
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
    const archives = [...BUILD_SCRIPT.matchAll(/'misao-[0-9.]+-([a-z0-9_-]+)\.(?:tar\.gz|zip)':/g)].map((m) => m[1]);
    expect(archives.sort()).toEqual([...MISAO_TARGETS].sort());
  });
});

describe('misaoFileName', () => {
  it('names the executable misao.exe on the Windows target only', () => {
    expect(misaoFileName('x86_64-pc-windows-msvc', 'misao')).toBe('misao.exe');
    for (const target of MISAO_TARGETS.filter((t) => t !== 'x86_64-pc-windows-msvc')) {
      expect(misaoFileName(target, 'misao')).toBe('misao');
    }
  });

  it('leaves the license files alone on every target', () => {
    for (const target of MISAO_TARGETS) expect(misaoFileName(target, 'LICENSE')).toBe('LICENSE');
  });

  it('is the same rule as the build script (which cannot import from src)', () => {
    expect(BUILD_SCRIPT).toContain("target.includes('-windows-') ? 'misao.exe' : 'misao'");
  });
});

describe('readMisaoBundle with the Windows target', () => {
  function withBundle(run: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'misao-bundle-'));
    try {
      writeHubBundle(root, '0.3.0', 'binary');
      run(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('reads misao.exe as the `misao` file of the Windows target, checked against the manifest', () => {
    withBundle((root) => {
      const files = readMisaoBundle(root)!.targets['x86_64-pc-windows-msvc'];
      expect(path.basename(files.files.misao)).toBe('misao.exe');
      expect(path.basename(files.files.LICENSE)).toBe('LICENSE');
    });
  });

  it('fails loudly when the Windows binary is missing or does not match its manifest', () => {
    withBundle((root) => {
      const exe = path.join(root, 'misao', 'x86_64-pc-windows-msvc', 'misao.exe');
      fs.writeFileSync(exe, 'tampered');
      expect(() => readMisaoBundle(root)).toThrow(/damaged/);
      fs.rmSync(exe);
      expect(() => readMisaoBundle(root)).toThrow(/misao\.exe is missing/);
    });
  });
});
