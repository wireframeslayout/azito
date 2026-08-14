import { describe, it, expect } from 'vitest';
import { resolveWindowRowTitle, buildWindowSearchText } from './windowRowTitle';

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

describe('buildWindowSearchText', () => {
  const base = {
    paneTitle: '◐ libghosttyのwasm版導入検討', paneCommand: 'node',
    label: 'task-231--x9oh', tmuxTarget: 'azito:win--us73', serverName: 'local',
    taskId: 338, taskTitle: 'v0.6.0検討', branch: 'task/338-transcript-v2',
  };

  it('matches on the dynamic pane title shown as the row title', () => {
    expect(buildWindowSearchText(base)).toContain('libghosttyのwasm版導入検討');
  });

  it('keeps matching on label / target / server / task ref / task title / branch', () => {
    const text = buildWindowSearchText(base);
    for (const q of ['task-231--x9oh', 'azito:win--us73', 'local', '#338', 'v0.6.0検討', 'task/338-transcript-v2']) {
      expect(text).toContain(q.toLowerCase());
    }
  });

  it('does not put the bare command name into the search text', () => {
    expect(buildWindowSearchText({ ...base, paneTitle: 'node', label: undefined, taskTitle: undefined, branch: undefined }))
      .not.toContain('node');
  });
});
