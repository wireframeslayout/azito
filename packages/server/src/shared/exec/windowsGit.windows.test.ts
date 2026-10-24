import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { resolveCurrentHostEnv } from '../os/hostEnv';
import { buildCommandSpec, GitNotFoundError } from './commandSpec';
import { runCommandSpec, runHostOf } from './runCommandSpec';
import { GitLocator, windowsProgramEnvOf, type WindowsProgramEnv } from './windowsGit';

/**
 * `git.exe` found on a real Windows host (the CI runner has Git for Windows installed, on PATH). The runner's own environment is
 * read the way the hub and the agent read theirs, then the PATH is taken away: the Task Scheduler starts the agent with a minimal
 * environment, and that is what the standard install locations are for.
 */
describe.skipIf(process.platform !== 'win32')('git.exe on a real Windows host', () => {
  const real = (): WindowsProgramEnv => {
    const env = resolveCurrentHostEnv().windowsPrograms;
    if (!env) throw new Error('a Windows host resolves its program environment');
    return env;
  };
  const withoutPath = (): WindowsProgramEnv => ({ ...real(), path: path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') });

  it('finds the git.exe of Git for Windows on PATH', async () => {
    expect((await new GitLocator(real()).resolve()).toLowerCase()).toMatch(/\\git(\\[^\\]+)*\\git\.exe$/);
  });

  it('finds cmd\\git.exe in a standard install location when PATH has no git', async () => {
    const found = await new GitLocator(withoutPath()).resolve();
    expect(found.toLowerCase()).toMatch(/\\git\\cmd\\git\.exe$/);
  });

  it('runs that git.exe through runCommandSpec with a minimal PATH', async () => {
    const host = runHostOf({ ...resolveCurrentHostEnv(), windowsPrograms: withoutPath() });
    const result = await runCommandSpec(buildCommandSpec('git', ['--version']), host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
  });

  it('is GitNotFoundError, not ENOENT, when there is no git in PATH or in any standard location', async () => {
    const nowhere: WindowsProgramEnv = {
      path: path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      pathExt: real().pathExt,
      programFiles: 'C:\\azito-no-such-dir\\pf',
      programFilesX86: 'C:\\azito-no-such-dir\\pf86',
      localAppData: 'C:\\azito-no-such-dir\\local',
    };
    const host = runHostOf({ ...resolveCurrentHostEnv(), windowsPrograms: nowhere });
    const error = await runCommandSpec(buildCommandSpec('git', ['--version']), host).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitNotFoundError);
    expect((error as GitNotFoundError).message).toContain('winget install --id Git.Git -e');
    expect((error as GitNotFoundError).message).toContain('C:\\azito-no-such-dir\\pf\\Git\\cmd\\git.exe');
  });

  it('reads PATH, PATHEXT and the install roots from the process environment', () => {
    const env = windowsProgramEnvOf(process.env);
    expect(env.path.length).toBeGreaterThan(0);
    expect(env.pathExt.toUpperCase()).toContain('.EXE');
    expect(env.programFiles).toBeTruthy();
  });
});
