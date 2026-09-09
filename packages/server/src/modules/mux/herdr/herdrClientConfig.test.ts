import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveHerdrLock } from '@azito/shared';
import { ensureHerdrClientConfigs, herdrClientConfigPath, herdrClientConfigDir } from './herdrClientConfig';

describe('herdrClientConfig', () => {
  const testDir = path.join(os.tmpdir(), `azito-herdr-test-${process.pid}`);
  const origHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = testDir;
    fs.rmSync(path.join(testDir, '.azito', 'herdr'), { recursive: true, force: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates both config files', () => {
    ensureHerdrClientConfigs();
    expect(fs.existsSync(herdrClientConfigPath('locked'))).toBe(true);
    expect(fs.existsSync(herdrClientConfigPath('free'))).toBe(true);
  });

  it('locked config contains [keys] section with empty bindings', () => {
    ensureHerdrClientConfigs();
    const content = fs.readFileSync(herdrClientConfigPath('locked'), 'utf-8');
    expect(content).toContain('[keys]');
    expect(content).toContain('workspace_picker = ""');
    expect(content).toContain('detach = ""');
    expect(content).toContain('prefix = "f24"');
  });

  it('free config does not contain [keys] section', () => {
    ensureHerdrClientConfigs();
    const content = fs.readFileSync(herdrClientConfigPath('free'), 'utf-8');
    expect(content).not.toContain('[keys]');
    expect(content).toContain('[ui]');
  });

  it('both configs share common [ui] settings', () => {
    ensureHerdrClientConfigs();
    for (const lock of ['locked', 'free'] as const) {
      const content = fs.readFileSync(herdrClientConfigPath(lock), 'utf-8');
      expect(content).toContain('sidebar_start_collapsed = true');
      expect(content).toContain('sidebar_collapsed_mode = "hidden"');
      expect(content).toContain('hide_tab_bar_when_single_tab = true');
      expect(content).toContain('mouse_capture = true');
      expect(content).toContain('onboarding = false');
    }
  });

  it('is idempotent — second call does not change files', () => {
    ensureHerdrClientConfigs();
    const stat1 = fs.statSync(herdrClientConfigPath('locked'));
    const content1 = fs.readFileSync(herdrClientConfigPath('locked'), 'utf-8');

    // wait a tick so mtime would differ if file is rewritten
    const now = new Date(Date.now() + 1000);
    fs.utimesSync(herdrClientConfigPath('locked'), now, now);
    const stat2 = fs.statSync(herdrClientConfigPath('locked'));
    expect(stat2.mtimeMs).not.toBe(stat1.mtimeMs);

    ensureHerdrClientConfigs();
    const content2 = fs.readFileSync(herdrClientConfigPath('locked'), 'utf-8');
    expect(content2).toBe(content1);
    // mtime should not have been reset by ensureHerdrClientConfigs since content is unchanged
    const stat3 = fs.statSync(herdrClientConfigPath('locked'));
    expect(stat3.mtimeMs).toBe(stat2.mtimeMs);
  });

  it('config path reflects lock type', () => {
    expect(herdrClientConfigPath('locked')).toContain('client-locked.toml');
    expect(herdrClientConfigPath('free')).toContain('client-free.toml');
  });

  it('config dir is under ~/.azito/herdr', () => {
    expect(herdrClientConfigDir()).toBe(path.join(testDir, '.azito', 'herdr'));
  });
});

describe('resolveHerdrLock', () => {
  it('returns window lock when set', () => {
    expect(resolveHerdrLock('locked', 'free')).toBe('free');
    expect(resolveHerdrLock('free', 'locked')).toBe('locked');
  });

  it('falls back to server lock when window is null', () => {
    expect(resolveHerdrLock('locked', null)).toBe('locked');
    expect(resolveHerdrLock('free', null)).toBe('free');
  });
});
