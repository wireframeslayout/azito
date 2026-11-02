import { describe, it, expect } from 'vitest';
import { sanitizedTmuxError, tmuxErrorReason, tmuxFailureReason } from './tmuxFailureReason';

describe('tmux failure reasons', () => {
  it('classifies output without returning it', () => {
    expect(tmuxFailureReason("can't find session: TOKEN=secret", 1)).toBe("can't find target");
    expect(tmuxFailureReason('error connecting to /tmp/tmux-1/default (No such file or directory)', 1)).toBe('no server running on tmux socket');
    expect(tmuxFailureReason('TOKEN=secret', 2)).toBe('exit 2');
  });

  it('keeps a timeout through a second sanitizing layer', () => {
    const first = sanitizedTmuxError('new-window', Object.assign(new Error('Command failed: tmux new-window -e TOKEN=secret'), { killed: true, code: null }));
    expect(first.message).toBe('tmux new-window failed: timed out');
    const second = sanitizedTmuxError('new-window', first);
    expect(second.message).toBe('tmux new-window failed: timed out');
    expect(second.killed).toBe(true);
    expect(JSON.stringify(second)).not.toContain('secret');
  });

  it('reads a non-exit failure as an execution failure', () => {
    expect(tmuxErrorReason(Object.assign(new Error('Agent request failed (500): TOKEN=secret'), { code: 'X' }))).toBe('execution failed');
    expect(tmuxErrorReason(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }))).toBe('binary not found');
  });
});
