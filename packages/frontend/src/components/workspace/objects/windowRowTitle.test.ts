import { describe, it, expect } from 'vitest';
import { resolveWindowDisplay } from '../../../lib/windowDisplay';
import { buildWindowSearchText } from './windowRowTitle';

describe('resolveWindowDisplay', () => {
  it('uses the pane title when it is a real title', () => {
    const result = resolveWindowDisplay({
      paneTitle: 'libghostty の wasm 版導入検討', paneCommand: 'node',
      label: 'task-231--x9oh', taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73',
    });
    expect(result.title).toBe('libghostty の wasm 版導入検討');
  });

  it('skips internal label and falls back to task title when the pane title is only the command name', () => {
    const result = resolveWindowDisplay({
      paneTitle: 'node', paneCommand: 'node',
      label: 'task-231--x9oh', taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73',
    });
    expect(result.title).toBe('タスクのタイトル');
  });

  it('falls back to the task title when offline and no label is set', () => {
    const result = resolveWindowDisplay({ taskTitle: 'タスクのタイトル', tmuxTarget: 'azito:win--us73' });
    expect(result.title).toBe('タスクのタイトル');
  });

  it('falls back to the tmux target when nothing else is available', () => {
    const result = resolveWindowDisplay({ paneTitle: '   ', label: '  ', tmuxTarget: 'azito:win--us73' });
    expect(result.title).toBe('azito:win--us73');
  });

  it('skips internal label and falls back to task title', () => {
    const result = resolveWindowDisplay({
      label: 'task-231--x9oh', taskTitle: 'Issue対応', tmuxTarget: 'azito:0',
    });
    expect(result.title).toBe('Issue対応');
    expect(result.hasDisplayName).toBe(true);
  });

  it('returns hasDisplayName: true for workerType label', () => {
    const result = resolveWindowDisplay({ workerType: 'claude', windowId: 123, tmuxTarget: 'azito:0' });
    expect(result.title).toBe('Claude');
    expect(result.idLabel).toBe('W-123');
    expect(result.hasDisplayName).toBe(true);
  });

  it('tab label shows "Claude · W-123" for workerType', () => {
    const d = resolveWindowDisplay({ workerType: 'claude', windowId: 42, tmuxTarget: 'azito:0' });
    const label = d.hasDisplayName && d.idLabel ? `${d.title} · ${d.idLabel}` : d.title;
    expect(label).toBe('Claude · W-42');
  });

  it('tooltip does not duplicate when title equals idLabel', () => {
    const d = resolveWindowDisplay({ windowId: 42, tmuxTarget: 'azito:0' });
    const parts = [d.title];
    if (d.idLabel && d.idLabel !== d.title) parts.push(d.idLabel);
    parts.push('local');
    expect(parts.join(' · ')).toBe('W-42 · local');
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

  it('旧タブ tab.id から windowId が取れる場合も W-ID が付く', () => {
    const d = resolveWindowDisplay({
      paneTitle: 'node', paneCommand: 'node',
      label: 'task-42--ab12',
      taskTitle: 'Deploy fix',
      windowId: 42,
      tmuxTarget: 'azito:win--ab12',
    });
    expect(d.title).toBe('Deploy fix');
    expect(d.idLabel).toBe('W-42');
    expect(d.hasDisplayName).toBe(true);
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
