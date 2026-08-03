import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveDataDir } from './dataDir';
import * as releaseInfo from './releaseInfo';

describe('resolveDataDir', () => {
  let tmpDir: string;
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-datadir-test-'));
    origEnv.AZITO_DATA_DIR = process.env.AZITO_DATA_DIR;
    origEnv.AZITO_SIDEKICKS_DIR = process.env.AZITO_SIDEKICKS_DIR;
  });

  afterEach(() => {
    process.env.AZITO_DATA_DIR = origEnv.AZITO_DATA_DIR;
    process.env.AZITO_SIDEKICKS_DIR = origEnv.AZITO_SIDEKICKS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns repo-root-relative paths when AZITO_DATA_DIR is unset', () => {
    delete process.env.AZITO_DATA_DIR;
    delete process.env.AZITO_SIDEKICKS_DIR;
    const paths = resolveDataDir();
    expect(paths.db).toMatch(/data\.db$/);
    expect(paths.masterKey).toMatch(/data[/\\]master\.key$/);
    expect(paths.vapidKeys).toMatch(/data[/\\]vapid-keys\.json$/);
    expect(paths.uiToken).toMatch(/data[/\\]ui-token$/);
    expect(paths.browserProfile).toMatch(/data[/\\]browser-profile$/);
    expect(paths.sidekicks).toMatch(/data[/\\]sidekicks$/);
  });

  it('consolidates all paths under AZITO_DATA_DIR when set', () => {
    const dataDir = path.join(tmpDir, 'azito-data');
    process.env.AZITO_DATA_DIR = dataDir;
    delete process.env.AZITO_SIDEKICKS_DIR;

    const paths = resolveDataDir();

    expect(paths.dir).toBe(dataDir);
    expect(paths.db).toBe(path.join(dataDir, 'data.db'));
    expect(paths.masterKey).toBe(path.join(dataDir, 'master.key'));
    expect(paths.vapidKeys).toBe(path.join(dataDir, 'vapid-keys.json'));
    expect(paths.uiToken).toBe(path.join(dataDir, 'ui-token'));
    expect(paths.browserProfile).toBe(path.join(dataDir, 'browser-profile'));
    expect(paths.sidekicks).toBe(path.join(dataDir, 'sidekicks'));

    const stat = fs.statSync(dataDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('respects AZITO_SIDEKICKS_DIR override when AZITO_DATA_DIR is set', () => {
    const dataDir = path.join(tmpDir, 'azito-data');
    const customSidekicks = path.join(tmpDir, 'custom-sidekicks');
    process.env.AZITO_DATA_DIR = dataDir;
    process.env.AZITO_SIDEKICKS_DIR = customSidekicks;

    const paths = resolveDataDir();
    expect(paths.sidekicks).toBe(customSidekicks);
    expect(paths.db).toBe(path.join(dataDir, 'data.db'));
  });

  it('respects AZITO_SIDEKICKS_DIR override when AZITO_DATA_DIR is unset', () => {
    delete process.env.AZITO_DATA_DIR;
    const customSidekicks = path.join(tmpDir, 'custom-sidekicks');
    process.env.AZITO_SIDEKICKS_DIR = customSidekicks;

    const paths = resolveDataDir();
    expect(paths.sidekicks).toBe(customSidekicks);
  });

  describe('release mode', () => {
    let isReleaseModeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      isReleaseModeSpy = vi.spyOn(releaseInfo, 'isReleaseMode');
    });

    afterEach(() => {
      isReleaseModeSpy.mockRestore();
    });

    it('uses ~/.azito/data when AZITO_DATA_DIR is unset in release mode', () => {
      delete process.env.AZITO_DATA_DIR;
      delete process.env.AZITO_SIDEKICKS_DIR;
      isReleaseModeSpy.mockReturnValue(true);

      const paths = resolveDataDir();
      const expected = path.join(os.homedir(), '.azito', 'data');

      expect(paths.dir).toBe(expected);
      expect(paths.db).toBe(path.join(expected, 'data.db'));
      expect(paths.masterKey).toBe(path.join(expected, 'master.key'));
      expect(paths.vapidKeys).toBe(path.join(expected, 'vapid-keys.json'));
      expect(paths.uiToken).toBe(path.join(expected, 'ui-token'));
      expect(paths.browserProfile).toBe(path.join(expected, 'browser-profile'));
      expect(paths.sidekicks).toBe(path.join(expected, 'sidekicks'));
    });

    it('does not reference bundle root in any path in release mode', () => {
      delete process.env.AZITO_DATA_DIR;
      delete process.env.AZITO_SIDEKICKS_DIR;
      isReleaseModeSpy.mockReturnValue(true);

      const bundleRoot = releaseInfo.resolveRoot();
      const paths = resolveDataDir();

      for (const [key, value] of Object.entries(paths)) {
        if (typeof value === 'string') {
          expect(value, `paths.${key} should not contain bundle root`).not.toContain(bundleRoot);
        }
      }
    });

    it('prefers explicit AZITO_DATA_DIR over release mode default', () => {
      const dataDir = path.join(tmpDir, 'explicit-data');
      process.env.AZITO_DATA_DIR = dataDir;
      isReleaseModeSpy.mockReturnValue(true);

      const paths = resolveDataDir();
      expect(paths.dir).toBe(dataDir);
      expect(paths.db).toBe(path.join(dataDir, 'data.db'));
    });

    it('uses repo root paths in source mode (non-release)', () => {
      delete process.env.AZITO_DATA_DIR;
      delete process.env.AZITO_SIDEKICKS_DIR;
      isReleaseModeSpy.mockReturnValue(false);

      const paths = resolveDataDir();
      expect(paths.db).toMatch(/data\.db$/);
      expect(paths.masterKey).toMatch(/data[/\\]master\.key$/);
    });
  });
});
