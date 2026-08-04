import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AgentBundler } from './AgentBundler';

describe('AgentBundler', () => {
  let bundler: AgentBundler;

  beforeEach(() => {
    bundler = new AgentBundler();
  });

  it('getHubSha returns a non-empty short SHA', () => {
    const sha = bundler.getHubSha();
    expect(sha).toBeTruthy();
    expect(sha.length).toBeGreaterThanOrEqual(7);
    expect(sha.length).toBeLessThanOrEqual(12);
    expect(sha).toMatch(/^[0-9a-f]+$/);
  });

  it('getTarballPath points to dist-agent directory', () => {
    const tarballPath = bundler.getTarballPath();
    expect(tarballPath).toContain('dist-agent');
    expect(tarballPath).toMatch(/azito-agent\.tar\.gz$/);
  });

  it('getBundledSha returns null when no version file exists', () => {
    const bundler2 = new AgentBundler();
    const tarballPath = bundler2.getTarballPath();
    const versionFile = path.join(path.dirname(tarballPath), 'version.txt');
    if (!fs.existsSync(versionFile)) {
      expect(bundler2.getBundledSha()).toBeNull();
    }
  });

  it('needsBuild returns true when tarball does not exist', () => {
    const tarballPath = bundler.getTarballPath();
    if (!fs.existsSync(tarballPath)) {
      expect(bundler.needsBuild()).toBe(true);
    }
  });

  it('needsBuild returns false when SHA matches', () => {
    const tarballPath = bundler.getTarballPath();
    const versionFile = path.join(path.dirname(tarballPath), 'version.txt');
    if (fs.existsSync(tarballPath) && fs.existsSync(versionFile)) {
      const bundledSha = fs.readFileSync(versionFile, 'utf-8').trim();
      const hubSha = bundler.getHubSha();
      if (bundledSha === hubSha) {
        expect(bundler.needsBuild()).toBe(false);
      }
    }
  });

  it('needsBuild returns true when bundle-hash.txt is missing (pre-scheme artifact)', () => {
    // An artifact built before the bundle-hash scheme has a matching git SHA but no
    // bundle-hash.txt — needsBuild must report stale so ensureBuild() self-heals it.
    const tarballPath = bundler.getTarballPath();
    const bundleHashFile = path.join(path.dirname(tarballPath), 'bundle-hash.txt');
    if (!fs.existsSync(tarballPath)) {
      return; // requires a real build to have run first
    }
    const backup = fs.existsSync(bundleHashFile) ? fs.readFileSync(bundleHashFile) : null;
    fs.rmSync(bundleHashFile, { force: true });
    try {
      expect(bundler.needsBuild()).toBe(true);
    } finally {
      if (backup) fs.writeFileSync(bundleHashFile, backup);
    }
  });

  it('getBundleHashIfBuilt returns null instead of throwing when artifacts are missing', () => {
    const tarballPath = bundler.getTarballPath();
    const bundleHashFile = path.join(path.dirname(tarballPath), 'bundle-hash.txt');
    if (fs.existsSync(tarballPath) && fs.existsSync(bundleHashFile)) {
      // Built: must agree with the throwing accessor.
      expect(bundler.getBundleHashIfBuilt()).toBe(bundler.getBundleHash());
      // Remove the hash file (fresh instance to bypass memoization) → null, no throw.
      const backup = fs.readFileSync(bundleHashFile);
      fs.rmSync(bundleHashFile, { force: true });
      try {
        expect(new AgentBundler().getBundleHashIfBuilt()).toBeNull();
      } finally {
        fs.writeFileSync(bundleHashFile, backup);
      }
    } else {
      expect(bundler.getBundleHashIfBuilt()).toBeNull();
    }
  });

  it('getSha256sumsPath points to SHA256SUMS in dist-agent', () => {
    const sumsPath = bundler.getSha256sumsPath();
    expect(sumsPath).toContain('dist-agent');
    expect(sumsPath).toMatch(/SHA256SUMS$/);
  });

  describe('getBundleHash', () => {
    // AgentBundler resolves dist-agent relative to its own module location (not
    // injectable), so these tests exercise the real dist-agent directory produced by
    // `npx tsx scripts/build-agent.ts` and no-op (like the needsBuild test above) when
    // that hasn't been run yet.

    it('reads the hash from bundle-hash.txt next to the tarball', () => {
      const tarballPath = bundler.getTarballPath();
      const bundleHashFile = path.join(path.dirname(tarballPath), 'bundle-hash.txt');
      if (!fs.existsSync(tarballPath) || !fs.existsSync(bundleHashFile)) {
        return;
      }
      const expected = fs.readFileSync(bundleHashFile, 'utf-8').trim();
      expect(bundler.getBundleHash()).toBe(expected);
    });

    it('throws when bundle-hash.txt is missing (fails fast, no silent fallback)', () => {
      const tarballPath = bundler.getTarballPath();
      const bundleHashFile = path.join(path.dirname(tarballPath), 'bundle-hash.txt');
      if (!fs.existsSync(tarballPath)) {
        return;
      }
      const backup = fs.existsSync(bundleHashFile) ? fs.readFileSync(bundleHashFile) : null;
      fs.rmSync(bundleHashFile, { force: true });
      try {
        expect(() => new AgentBundler().getBundleHash()).toThrow();
      } finally {
        if (backup) fs.writeFileSync(bundleHashFile, backup);
      }
    });

    it('reads bundle-hash.txt in release mode too, not the hub bundle hash', async () => {
      // Release builds ship dist-agent/bundle-hash.txt alongside the tarball. Returning
      // release.json's `bundleHash` here instead would identify the *hub* bundle, which
      // never equals the version a deployed agent reports — every agent install/update
      // would then fail its health check with "Version mismatch".
      const tarballPath = bundler.getTarballPath();
      const bundleHashFile = path.join(path.dirname(tarballPath), 'bundle-hash.txt');
      if (!fs.existsSync(tarballPath) || !fs.existsSync(bundleHashFile)) {
        return;
      }
      const agentHash = fs.readFileSync(bundleHashFile, 'utf-8').trim();

      vi.resetModules();
      vi.doMock('../../../shared/releaseInfo', () => ({
        isReleaseMode: () => true,
        getBundleRoot: () => null,
        getReleaseInfo: () => ({
          version: 'v0.0.0-test',
          commit: 'deadbee',
          bundleHash: 'hub-bundle-hash-must-not-be-used',
          channel: { repo: 'example/repo' },
        }),
      }));
      try {
        const { AgentBundler: Fresh } = await import('./AgentBundler.js');
        expect(new Fresh().getBundleHash()).toBe(agentHash);
      } finally {
        vi.doUnmock('../../../shared/releaseInfo');
        vi.resetModules();
      }
    });

    it('memoizes by tarball mtime+size, avoiding a re-read once cached', () => {
      const tarballPath = bundler.getTarballPath();
      const bundleHashFile = path.join(path.dirname(tarballPath), 'bundle-hash.txt');
      if (!fs.existsSync(tarballPath) || !fs.existsSync(bundleHashFile)) {
        return;
      }
      const first = bundler.getBundleHash();
      // Mutate the on-disk hash file without touching the tarball — the cached value
      // (keyed by tarball mtime+size) should still be returned.
      const original = fs.readFileSync(bundleHashFile, 'utf-8');
      fs.writeFileSync(bundleHashFile, 'tampered-value-should-not-be-seen');
      try {
        expect(bundler.getBundleHash()).toBe(first);
      } finally {
        fs.writeFileSync(bundleHashFile, original);
      }
    });
  });
});
