import { describe, it, expect } from 'vitest';
import { GIT_NOT_FOUND_RETRY_MS, GitLocator, windowsProgramEnvOf, type GitLocatorIo, type WindowsProgramEnv } from './windowsGit';
import { GitNotFoundError } from './commandSpec';
import { runCommandSpec, runHostOf } from './runCommandSpec';
import { buildCommandSpec } from './commandSpec';
import { responseToResult, runToResponse } from './runWire';

const env = (over: Partial<WindowsProgramEnv> = {}): WindowsProgramEnv => ({
  path: 'C:\\Windows\\System32;C:\\Tools',
  pathExt: '.COM;.EXE;.BAT;.CMD',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  localAppData: 'C:\\Users\\me\\AppData\\Local',
  ...over,
});

function fakeIo(files: string[]): GitLocatorIo & { files: Set<string>; clock: number; checked: string[] } {
  // Windows file names are case-insensitive: the fake compares lower-cased, like the host.
  const state = { files: new Set(files.map((f) => f.toLowerCase())), clock: 0, checked: [] as string[] };
  return Object.assign(state, {
    isFile: async (file: string) => { state.checked.push(file); return state.files.has(file.toLowerCase()); },
    now: () => state.clock,
  });
}

describe('GitLocator', () => {
  it('prefers PATH, with the PATHEXT extensions that can be started (not .BAT / .CMD)', async () => {
    const io = fakeIo(['C:\\Tools\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe']);
    expect(await new GitLocator(env(), io).resolve()).toBe('C:\\Tools\\git.exe');
    expect(io.checked).not.toContain('C:\\Tools\\git.BAT');
    expect(io.checked).not.toContain('C:\\Tools\\git.CMD');
  });

  it('falls back to the standard locations in order: Program Files, Program Files (x86), the per-user install', async () => {
    expect(await new GitLocator(env(), fakeIo(['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'])).resolve()).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(await new GitLocator(env(), fakeIo(['C:\\Program Files (x86)\\Git\\cmd\\git.exe'])).resolve()).toBe('C:\\Program Files (x86)\\Git\\cmd\\git.exe');
    expect(await new GitLocator(env(), fakeIo(['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'])).resolve()).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe');
  });

  it('never names bin\\git.exe or mingw64\\bin\\git.exe', async () => {
    const io = fakeIo([]);
    await expect(new GitLocator(env(), io).resolve()).rejects.toBeInstanceOf(GitNotFoundError);
    expect(io.checked.some((f) => /\\bin\\git\.exe$/i.test(f))).toBe(false);
  });

  it('strips quotes and skips empty entries in PATH', async () => {
    const io = fakeIo(['C:\\My Tools\\git.exe']);
    expect(await new GitLocator(env({ path: ';"C:\\My Tools";' }), io).resolve()).toBe('C:\\My Tools\\git.exe');
  });

  it.each(['.', 'tools', 'C:tools', '\\tools', '..\\x', '%USERPROFILE%\\bin'])('never takes the PATH entry %s as a place to look (not fully qualified)', async (entry) => {
    const io = fakeIo([]);
    await expect(new GitLocator(env({ path: `${entry};C:\\Tools`, programFiles: '.', programFilesX86: 'pf86', localAppData: undefined }), io).resolve()).rejects.toBeInstanceOf(GitNotFoundError);
    // only C:\\Tools is a place
    expect(io.checked.every((f) => /^[A-Za-z]:\\/.test(f))).toBe(true);
    expect(io.checked).toContain('C:\\Tools\\git.exe');
  });

  it('takes a UNC share and a drive path with forward slashes', async () => {
    const io = fakeIo(['\\\\srv\\tools\\git.exe']);
    expect(await new GitLocator(env({ path: 'C:/bin;\\\\srv\\tools' }), io).resolve()).toBe('\\\\srv\\tools\\git.exe');
  });

  it('looks on PATH with .exe / .com when PATHEXT is empty', async () => {
    expect(await new GitLocator(env({ pathExt: '' }), fakeIo(['C:\\Tools\\git.exe'])).resolve()).toBe('C:\\Tools\\git.exe');
  });

  it('says what to install and where it looked when there is no git', async () => {
    const error = await new GitLocator(env(), fakeIo([])).resolve().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitNotFoundError);
    const message = (error as GitNotFoundError).message;
    expect(message).toContain('winget install --id Git.Git -e');
    expect(message).toContain('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(message).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe');
    expect((error as GitNotFoundError).code).toBe('GIT_NOT_FOUND');
  });

  it('keeps a found path without searching again, but searches again when it is gone', async () => {
    const io = fakeIo(['C:\\Tools\\git.exe']);
    const locator = new GitLocator(env(), io);
    await locator.resolve();
    io.checked.length = 0;
    await locator.resolve();
    expect(io.checked).toEqual(['C:\\Tools\\git.exe']);
    io.files.clear();
    io.files.add('c:\\program files\\git\\cmd\\git.exe');
    expect(await locator.resolve()).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('keeps a miss for a while, then looks again (a git installed meanwhile is found)', async () => {
    const io = fakeIo([]);
    const locator = new GitLocator(env(), io);
    await expect(locator.resolve()).rejects.toBeInstanceOf(GitNotFoundError);
    io.files.add('c:\\program files\\git\\cmd\\git.exe');
    io.clock = GIT_NOT_FOUND_RETRY_MS - 1;
    await expect(locator.resolve()).rejects.toBeInstanceOf(GitNotFoundError);
    io.clock = GIT_NOT_FOUND_RETRY_MS;
    expect(await locator.resolve()).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('explains the missing install locations when ProgramFiles and LOCALAPPDATA are not set', async () => {
    const e = env({ programFiles: undefined, programFilesX86: undefined, localAppData: undefined });
    await expect(new GitLocator(e, fakeIo([])).resolve()).rejects.toThrow(/no standard install location/);
  });
});

describe('windowsProgramEnvOf', () => {
  it('reads PATH, PATHEXT and the install roots', () => {
    expect(windowsProgramEnvOf({ PATH: 'a', PATHEXT: '.EXE', ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', LOCALAPPDATA: 'la' }))
      .toEqual({ path: 'a', pathExt: '.EXE', programFiles: 'pf', programFilesX86: 'pf86', localAppData: 'la' });
  });
});

describe('git_not_found across the agent wire', () => {
  it('stays a GitNotFoundError on the hub side of POST /api/run', async () => {
    const agentHost = runHostOf({ platform: 'win32', systemRoot: undefined, windowsPrograms: env({ path: '', programFiles: undefined, programFilesX86: undefined, localAppData: undefined }) });
    const body = await runToResponse(buildCommandSpec('git', ['--version']), agentHost);
    expect(body).toMatchObject({ outcome: 'spawn_failed', code: 'GIT_NOT_FOUND' });
    expect(() => responseToResult(body)).toThrow(GitNotFoundError);
  });
});

describe('runCommandSpec and git on a Windows host', () => {
  it('asks the host for git.exe before it spawns, and reports a missing one as GitNotFoundError (not ENOENT)', async () => {
    const host = runHostOf({ platform: 'win32', systemRoot: undefined, windowsPrograms: env({ path: '', programFiles: undefined, programFilesX86: undefined, localAppData: undefined }) });
    await expect(runCommandSpec(buildCommandSpec('git', ['--version']), host)).rejects.toBeInstanceOf(GitNotFoundError);
  });

  it('refuses git when the runner was built without a search', async () => {
    const host = runHostOf({ platform: 'win32', systemRoot: undefined });
    await expect(runCommandSpec(buildCommandSpec('git', ['--version']), host)).rejects.toThrow(/no search for git\.exe/);
  });

  it('leaves a POSIX host alone: git is looked up by the OS', async () => {
    const host = runHostOf({ platform: 'linux', systemRoot: undefined });
    expect(host).toEqual({ windows: false });
  });
});
