import { describe, it, expect } from 'vitest';
import type { MuxRef } from '@azito/shared';
import { isSameWindow, taskWindowRef, windowDisplayName, windowRefOf } from './windowIdentity';

const ID_A = 'w_01M3XFD8H97JCPKS5Y5BH3JZQH';
const ID_B = 'w_01M3XFD8H97JCPKS5Y5BH3JZQJ';
const misao = (workspace: string, window: string): MuxRef => ({ kind: 'misao', workspace, window });
const tmux = (workspace: string, window: string): MuxRef => ({ kind: 'tmux', workspace, window });

describe('windowRefOf', () => {
  it('prefers mux_ref', () => {
    expect(windowRefOf({ muxRef: misao('ws', ID_A), tmuxTarget: 'other:x' }, 'misao')).toEqual(misao('ws', ID_A));
  });

  it('derives the ref from tmux_target with the driver kind when mux_ref is missing', () => {
    expect(windowRefOf({ tmuxTarget: `ws:${ID_A}.1` }, 'misao')).toEqual(misao('ws', ID_A));
    expect(windowRefOf({ tmuxTarget: 'sess:win--ab' }, 'tmux')).toEqual(tmux('sess', 'win--ab'));
  });
});

describe('taskWindowRef', () => {
  it('uses the primary row when there is one, even if task.tmuxWindow disagrees', () => {
    expect(taskWindowRef({ tmuxWindow: 'task-1--ab' }, { muxRef: misao('ws', ID_A), tmuxTarget: `ws:${ID_A}` }, 'azito', 'misao')).toEqual(misao('ws', ID_A));
  });

  it('falls back to task.tmuxWindow in the task workspace', () => {
    expect(taskWindowRef({ tmuxWindow: ID_B }, undefined, 'azito', 'misao')).toEqual(misao('azito', ID_B));
    expect(taskWindowRef({ tmuxWindow: 'task-1' }, undefined, 'azito', 'tmux')).toEqual(tmux('azito', 'task-1'));
  });

  it('tmux ignores the primary row (behaviour unchanged) unless the caller reads it first', () => {
    const row = { muxRef: tmux('other', 'stale'), tmuxTarget: 'other:stale' };
    expect(taskWindowRef({ tmuxWindow: 'task-1' }, row, 'azito', 'tmux')).toEqual(tmux('azito', 'task-1'));
    expect(taskWindowRef({ tmuxWindow: 'task-1' }, row, 'azito', 'tmux', { tmuxPrefersPrimary: true })).toEqual(tmux('other', 'stale'));
  });

  it('is null for a task with no window', () => {
    expect(taskWindowRef({ tmuxWindow: null }, undefined, 'azito', 'misao')).toBeNull();
  });
});

describe('isSameWindow', () => {
  it('misao: the window id decides, wherever the window lives', () => {
    expect(isSameWindow(misao('a', ID_A), misao('b', ID_A))).toBe(true);
    expect(isSameWindow(misao('a', ID_A), misao('a', ID_B))).toBe(false);
  });

  it('tmux: workspace and window name', () => {
    expect(isSameWindow(tmux('s', 'w'), tmux('s', 'w'))).toBe(true);
    expect(isSameWindow(tmux('s', 'w'), tmux('t', 'w'))).toBe(false);
  });

  it('never equates different kinds', () => {
    expect(isSameWindow(tmux('s', ID_A), misao('s', ID_A))).toBe(false);
  });
});

describe('windowDisplayName', () => {
  it('returns the label', () => {
    expect(windowDisplayName({ label: 'task-1--ab12' })).toBe('task-1--ab12');
  });

  it('ignores a missing label or one that is a window id', () => {
    expect(windowDisplayName({ label: null })).toBeUndefined();
    expect(windowDisplayName({ label: '  ' })).toBeUndefined();
    expect(windowDisplayName({ label: ID_A })).toBeUndefined();
  });
});
