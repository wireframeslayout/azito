import { describe, it, expect } from 'vitest';
import { resolveWindowRowTitle } from './windowRowTitle';

describe('resolveWindowRowTitle', () => {
  it('uses the pane title when it is a real title', () => {
    expect(resolveWindowRowTitle({
      paneTitle: 'libghostty の wasm 版導入検討', paneCommand: 'node',
      label: 'task-231--x9oh', taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73',
    })).toBe('libghostty の wasm 版導入検討');
  });

  it('falls back to the window label when the pane title is only the command name', () => {
    expect(resolveWindowRowTitle({
      paneTitle: 'node', paneCommand: 'node',
      label: 'task-231--x9oh', taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73',
    })).toBe('task-231--x9oh');
  });

  it('falls back to the task title when offline and no label is set', () => {
    expect(resolveWindowRowTitle({ taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73' }))
      .toBe('タスクのタイトル');
  });

  it('falls back to the tmux target when nothing else is available', () => {
    expect(resolveWindowRowTitle({ paneTitle: '   ', label: '  ', tmuxTarget: 'azito:win--us73' }))
      .toBe('azito:win--us73');
  });
});
