import { describe, it, expect } from 'vitest';
import { resolveWindowRowTitle, resolveWindowDisplay, buildWindowSearchText } from './windowRowTitle';

describe('resolveWindowRowTitle', () => {
  it('uses the pane title when it is a real title', () => {
    expect(resolveWindowRowTitle({
      paneTitle: 'libghostty の wasm 版導入検討', paneCommand: 'node',
      label: 'task-231--x9oh', taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73',
    })).toBe('libghostty の wasm 版導入検討');
  });

  it('skips internal label and falls back to task title when the pane title is only the command name', () => {
    expect(resolveWindowRowTitle({
      paneTitle: 'node', paneCommand: 'node',
      label: 'task-231--x9oh', taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73',
    })).toBe('タスクのタイトル');
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

  it('includes windowId search terms', () => {
    const text = buildWindowSearchText({ ...base, windowId: 123 });
    expect(text).toContain('w-123');
    expect(text).toContain('w123');
    expect(text).toContain('123');
  });
});

describe('resolveWindowDisplay', () => {
  it('skips internal label and falls back to task title', () => {
    const result = resolveWindowDisplay({
      label: 'task-231--x9oh', taskTitle: 'Issue対応', tmuxTarget: 'azito:0',
    });
    expect(result.title).toBe('Issue対応');
    expect(result.hasDisplayName).toBe(true);
  });

  it('returns workerType label', () => {
    const result = resolveWindowDisplay({ workerType: 'claude', tmuxTarget: 'azito:0' });
    expect(result.title).toBe('Claude');
    expect(result.hasDisplayName).toBe(false);
  });

  it('falls back to W-123 when only windowId is available', () => {
    const result = resolveWindowDisplay({ windowId: 123, tmuxTarget: 'azito:0' });
    expect(result.title).toBe('W-123');
    expect(result.idLabel).toBeUndefined();
    expect(result.hasDisplayName).toBe(false);
  });

  it('falls back to tmuxTarget for unregistered windows', () => {
    const result = resolveWindowDisplay({ tmuxTarget: 'azito:0' });
    expect(result.title).toBe('azito:0');
  });

  it('keeps human-readable label', () => {
    const result = resolveWindowDisplay({ label: 'build server', tmuxTarget: 'azito:0' });
    expect(result.title).toBe('build server');
    expect(result.hasDisplayName).toBe(true);
  });
});
