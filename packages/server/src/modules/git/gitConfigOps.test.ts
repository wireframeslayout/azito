import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGitConfigValue, setGitConfigValue } from './gitConfigOps';

describe('gitConfigOps (local integration)', () => {
  let tmpDir: string;
  let repoDir: string;
  let savedHome: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcfg-'));
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', repoDir]);
    savedHome = process.env.HOME;
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome; else delete process.env.HOME;
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg; else delete process.env.XDG_CONFIG_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string for unset key (exit code 1)', async () => {
    const val = await getGitConfigValue('local', undefined, repoDir, 'user.email');
    expect(val).toBe('');
  });

  it('returns value for set key', async () => {
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
    const val = await getGitConfigValue('local', undefined, repoDir, 'user.email');
    expect(val).toBe('test@example.com');
  });

  it('sets and reads back a value', async () => {
    await setGitConfigValue('local', undefined, repoDir, 'user.name', 'Test User');
    const val = await getGitConfigValue('local', undefined, repoDir, 'user.name');
    expect(val).toBe('Test User');
  });

  it('throws for non-existent repo path', async () => {
    await expect(getGitConfigValue('local', undefined, '/nonexistent-path-xyz', 'user.name')).rejects.toThrow();
  });
});
