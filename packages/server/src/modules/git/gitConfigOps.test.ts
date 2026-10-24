import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { getGitConfigValue, setGitConfigValue } from './gitConfigOps';
import { LocalTransport } from '../servers/transport/LocalTransport';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { toHostProfile } from '../../shared/os/hostProfile';
import type { CommandResult, CommandSpec } from '../../shared/exec/commandSpec';
import type { GitTransport } from './gitPath';

/**
 * The git config reads and writes through LocalTransport (the one path a local server and an agent share), against the git on
 * the machine the test runs on (Git for Windows on the Windows CI runner), with a repository in a folder with a space and
 * Japanese characters.
 */
const hostEnv = resolveCurrentHostEnv();
const transport = new LocalTransport({ bin: 'tmux', baseArgs: [] } as never, 'http://hub', hostEnv, TaskTempFiles.fromHostEnv(hostEnv), toHostProfile(hostEnv.platform, hostEnv.arch));

describe('gitConfigOps (real git through LocalTransport)', () => {
  let tmpDir: string;
  let repoDir: string;
  const saved: Record<string, string | undefined> = {};
  const ISOLATED = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gitcfg-')));
    repoDir = path.join(tmpDir, 'my repo 日本語');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', '-q', repoDir]);
    // A global identity of the machine running the test must not make an unset key look set.
    for (const key of ISOLATED) saved[key] = process.env[key];
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    process.env.GIT_CONFIG_GLOBAL = path.join(tmpDir, 'no-global-config');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterEach(() => {
    for (const key of ISOLATED) {
      if (saved[key] !== undefined) process.env[key] = saved[key]; else delete process.env[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty string for an unset key (git config exits 1)', async () => {
    expect(await getGitConfigValue(transport, repoDir, 'user.email')).toBe('');
  });

  it('returns the value of a set key', async () => {
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
    expect(await getGitConfigValue(transport, repoDir, 'user.email')).toBe('test@example.com');
  });

  it('sets a value (with spaces and non-ASCII characters) and reads it back', async () => {
    await setGitConfigValue(transport, repoDir, 'user.name', 'Test ユーザー "Q" $(id)');
    expect(await getGitConfigValue(transport, repoDir, 'user.name')).toBe('Test ユーザー "Q" $(id)');
  });

  it('throws for a repository that does not exist (git exits 128, which is not "unset")', async () => {
    await expect(getGitConfigValue(transport, path.join(tmpDir, 'nonexistent-path-xyz'), 'user.name')).rejects.toThrow(/git config user\.name read failed/);
    await expect(setGitConfigValue(transport, path.join(tmpDir, 'nonexistent-path-xyz'), 'user.name', 'x')).rejects.toThrow(/git config user\.name failed/);
  });

  it('runs git as an argv with -C and the key, with a timeout (no shell line)', async () => {
    const calls: CommandSpec[] = [];
    const fake: GitTransport = { run: async (spec: CommandSpec): Promise<CommandResult> => { calls.push(spec); return { exitCode: 0, signal: null, stdout: 'v\n', stderr: '' }; } };
    expect(await getGitConfigValue(fake, "/w/it's here", 'user.name')).toBe('v');
    await setGitConfigValue(fake, 'C:\\w\\repo', 'user.email', 'a@b.c');
    expect(calls.map((c) => [c.file, c.args])).toEqual([
      ['git', ['-C', "/w/it's here", 'config', 'user.name']],
      ['git', ['-C', 'C:\\w\\repo', 'config', 'user.email', 'a@b.c']],
    ]);
    expect(calls.every((c) => c.timeoutMs === 10_000)).toBe(true);
  });

  it('does not take a failure with output on stderr for an unset key', async () => {
    const fake: GitTransport = { run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'error: invalid key: a' }) };
    await expect(getGitConfigValue(fake, '/w', 'a')).rejects.toThrow(/invalid key/);
  });
});
