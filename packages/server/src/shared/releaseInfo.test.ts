import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getReleaseInfo, isReleaseMode, getBundleRoot, resolveRoot, _resetCache } from './releaseInfo';

describe('releaseInfo', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-release-test-'));
    _resetCache();
  });

  afterEach(() => {
    _resetCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleRelease = {
    version: 'v1.0.0',
    commit: 'abc1234',
    bundleHash: 'def567890abc',
    channel: { repo: 'wireframeslayout/azito' },
  };

  it('returns null when release.json does not exist', () => {
    expect(getReleaseInfo(tmpDir)).toBeNull();
  });

  it('isReleaseMode returns false when release.json does not exist', () => {
    expect(isReleaseMode(tmpDir)).toBe(false);
  });

  it('getBundleRoot returns null when release.json does not exist', () => {
    expect(getBundleRoot(tmpDir)).toBeNull();
  });

  it('returns release info when release.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'release.json'), JSON.stringify(sampleRelease));
    const info = getReleaseInfo(tmpDir);
    expect(info).toEqual(sampleRelease);
  });

  it('isReleaseMode returns true when release.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'release.json'), JSON.stringify(sampleRelease));
    expect(isReleaseMode(tmpDir)).toBe(true);
  });

  it('getBundleRoot returns basePath when release.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'release.json'), JSON.stringify(sampleRelease));
    expect(getBundleRoot(tmpDir)).toBe(tmpDir);
  });

  it('resolveRoot returns repo root in source mode', () => {
    const root = resolveRoot();
    expect(fs.existsSync(path.join(root, 'packages'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
  });
});
