import { describe, it, expect } from 'vitest';
import { resolveTmuxRuntime } from './TmuxRuntime';

describe('resolveTmuxRuntime', () => {
  it('returns system defaults', () => {
    const rt = resolveTmuxRuntime('system', '/home/user');
    expect(rt.bin).toBe('tmux');
    expect(rt.baseArgs).toEqual([]);
  });

  it('returns managed paths', () => {
    const rt = resolveTmuxRuntime('managed', '/home/user');
    expect(rt.bin).toBe('/home/user/.azito/tmux/bin/tmux');
    expect(rt.baseArgs).toEqual(['-L', 'azito', '-f', '/home/user/.azito/tmux/azito.conf']);
  });
});
