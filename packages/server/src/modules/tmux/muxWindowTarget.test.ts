import { describe, expect, it } from 'vitest';
import { muxWindowTarget } from './muxWindowTarget';

describe('muxWindowTarget', () => {
  it('returns the tmux target for a tmux ref', () => {
    expect(muxWindowTarget({ kind: 'tmux', workspace: 'azito', window: 'task-1' })).toBe('azito:task-1');
  });

  it('joins workspace and window id for a misao ref instead of throwing', () => {
    expect(muxWindowTarget({ kind: 'misao', workspace: 'azito', window: 'w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8' })).toBe('azito:w_01J9Z8Y7X6W5V4T3S2R1Q0P9N8');
  });
});
