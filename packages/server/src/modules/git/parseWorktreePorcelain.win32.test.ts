import { describe, expect, it } from 'vitest';
import { parseWorktreePorcelain } from './parseWorktreePorcelain';

describe('parseWorktreePorcelain on win32', () => {
  it('returns the paths git for Windows prints (forward slashes, CRLF tolerated) in the host spelling', () => {
    const output = 'worktree C:/Users/x y/日本語\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\nworktree //srv/share/repo/.worktrees/task-1\r\nHEAD def\r\ndetached\r\n';
    expect(parseWorktreePorcelain(output, 'win32')).toEqual([
      { path: 'C:\\Users\\x y\\日本語', branch: 'main', head: 'abc', isMain: true, locked: false },
      { path: '\\\\srv\\share\\repo\\.worktrees\\task-1', branch: null, head: 'def', isMain: false, locked: false },
    ]);
  });

  it('leaves a POSIX path with a space or Japanese characters as it is', () => {
    expect(parseWorktreePorcelain('worktree /home/u/my repo/日本語\nHEAD abc\nbranch refs/heads/main\n', 'linux')[0].path).toBe('/home/u/my repo/日本語');
  });
});
