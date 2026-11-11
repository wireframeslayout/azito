import { promises as fs } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findWindowsHeadlessCommand, windowsShimCommand } from './windowsHeadlessCommand';

describe('Windows headless command', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('goes on past a PATH directory that cannot be read', async () => {
    vi.spyOn(fs, 'stat').mockImplementation(async file => {
      if (String(file).startsWith('C:\\locked\\')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (String(file) === 'D:\\bin\\codex.CMD') return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const result = await findWindowsHeadlessCommand('codex', { PATH: 'C:\\locked;D:\\bin', PATHEXT: '.CMD' });
    expect(result.file).toBe('D:\\bin\\codex.CMD');
  });
  it('searches absolute directories and PATHEXT in order', async () => {
    const visited: string[] = [];
    const result = await findWindowsHeadlessCommand('codex', { PATH: 'relative;"C:\\Program Files\\npm";D:\\bin', PATHEXT: '.CMD;.EXE;.JS' }, async file => { visited.push(file); return file === 'D:\\bin\\codex.CMD'; });
    expect(visited).toEqual(['C:\\Program Files\\npm\\codex.CMD', 'C:\\Program Files\\npm\\codex.EXE', 'D:\\bin\\codex.CMD']);
    expect(result.search.extensions).toEqual(['.CMD', '.EXE']);
    expect(result.search.directories).toEqual(['C:\\Program Files\\npm', 'D:\\bin']);
  });
  it('reports the search and default extensions on a miss', async () => {
    const result = await findWindowsHeadlessCommand('claude', { PATH: ';.;C:\\bin' }, async () => false);
    expect(result).toEqual({ file: null, search: { directories: ['C:\\bin'], extensions: ['.COM', '.EXE', '.BAT', '.CMD'] } });
  });
  it.each(['%', '^', '&', '|', '<', '>', '"', '!', '(', ')', '\n'])('rejects unsafe argument %s', ch => {
    expect(() => windowsShimCommand('C:\\bin\\codex.cmd', [`a${ch}b`], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toThrow();
  });
  it('uses defaults for an empty PATHEXT', async () => {
    expect((await findWindowsHeadlessCommand('codex', { PATHEXT: '' }, async () => false)).search.extensions).toEqual(['.COM', '.EXE', '.BAT', '.CMD']);
  });
  it('quotes spaces and empty arguments', () => {
    expect(windowsShimCommand('C:\\Program Files\\codex.cmd', ['a b', ''], { SystemRoot: 'C:\\Windows' }).args[3]).toBe('""C:\\Program Files\\codex.cmd" "a b" """');
  });
});
