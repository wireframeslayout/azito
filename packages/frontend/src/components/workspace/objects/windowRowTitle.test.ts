import { describe, it, expect } from 'vitest';
import { resolveWindowDisplay, formatWindowDisplayLabel, buildWindowIndex, type WindowIndexEntry } from '../../../lib/windowDisplay';
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
    expect(formatWindowDisplayLabel(d)).toBe('Claude · W-42');
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

  it('formatWindowDisplayLabel で内部名ラベルが除外される', () => {
    const d = resolveWindowDisplay({
      label: 'task-42--ab12',
      taskTitle: 'Deploy fix',
      windowId: 42,
      tmuxTarget: 'azito:win--ab12',
    });
    expect(formatWindowDisplayLabel(d)).toBe('Deploy fix · W-42');
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

  it('strips generated suffix from user label', () => {
    const d = resolveWindowDisplay({ label: 'editor--ab12', windowId: 123, tmuxTarget: 'azito:0' });
    expect(d.title).toBe('editor');
    expect(d.idLabel).toBe('W-123');
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

  it('別プロジェクトの窓でも workerType があればラベル付きで表示される', () => {
    const d = resolveWindowDisplay({
      windowId: 99,
      workerType: 'codex',
      label: 'win--ab12',
      tmuxTarget: 'azito:win--ab12',
    });
    expect(d.title).toBe('Codex');
    expect(d.idLabel).toBe('W-99');
    expect(d.hasDisplayName).toBe(true);
  });

  it('ID のみの窓は hasDisplayName: false で idLabel: undefined（二重表示防止）', () => {
    const d = resolveWindowDisplay({ windowId: 50, tmuxTarget: 'azito:0' });
    expect(d.title).toBe('W-50');
    expect(d.idLabel).toBeUndefined();
    expect(d.hasDisplayName).toBe(false);
  });

  it('renderTitle が undefined を返したとき行側は idLabel で判定する（Objects 二重表示テスト）', () => {
    const d = resolveWindowDisplay({ windowId: 50, tmuxTarget: 'azito:0' });
    const renderTitleResult = d.hasDisplayName ? d.title : undefined;
    expect(renderTitleResult).toBeUndefined();
    const showIdChip = renderTitleResult != null ? true : !!d.idLabel;
    expect(showIdChip).toBe(false);
  });
});

describe('formatWindowDisplayLabel', () => {
  it('formats display with name and id', () => {
    expect(formatWindowDisplayLabel({ title: 'Claude', idLabel: 'W-42', hasDisplayName: true })).toBe('Claude · W-42');
  });

  it('formats display with id only', () => {
    expect(formatWindowDisplayLabel({ title: 'W-42', hasDisplayName: false })).toBe('W-42');
  });

  it('formats display without idLabel', () => {
    expect(formatWindowDisplayLabel({ title: 'azito:0', hasDisplayName: false })).toBe('azito:0');
  });

  it('workerType が渡されればアイドル中でも Claude · W-123 になる', () => {
    const d = resolveWindowDisplay({ windowId: 123, workerType: 'claude', tmuxTarget: 'azito:win--ab12' });
    expect(formatWindowDisplayLabel(d)).toBe('Claude · W-123');
  });
});

describe('formatWindowDisplayLabel with pane suffix', () => {
  it('旧形式タブのペイン番号は title に付く（名前.2 · W-42 の形式）', () => {
    const d = resolveWindowDisplay({
      label: 'task-42--ab12',
      taskTitle: 'Deploy fix',
      windowId: 42,
      tmuxTarget: 'azito:win--ab12',
    });
    // Simulate the legacy tab pane suffix logic: append to title before formatting
    const titleWithPane = `${d.title}.2`;
    const displayWithPane = { ...d, title: titleWithPane };
    expect(formatWindowDisplayLabel(displayWithPane)).toBe('Deploy fix.2 · W-42');
  });

  it('ペインが1つのときはサフィックスなし', () => {
    const d = resolveWindowDisplay({
      workerType: 'claude',
      windowId: 42,
      tmuxTarget: 'azito:win--ab12',
    });
    expect(formatWindowDisplayLabel(d)).toBe('Claude · W-42');
  });

  it('windowId タブで複数ペイン時はタイトルにペイン番号が付く', () => {
    const d = resolveWindowDisplay({
      paneTitle: 'building CI pipeline',
      paneCommand: 'node',
      windowId: 42,
      tmuxTarget: 'azito:win--ab12',
    });
    const titleWithPane = `${d.title}.2`;
    const displayWithPane = { ...d, title: titleWithPane };
    expect(formatWindowDisplayLabel(displayWithPane)).toBe('building CI pipeline.2 · W-42');
  });

  it('tmuxTarget のみのフォールバックで resolveWindowDisplay を通る', () => {
    const d = resolveWindowDisplay({ tmuxTarget: 'W-42' });
    expect(d.title).toBe('W-42');
    expect(d.hasDisplayName).toBe(false);
    expect(formatWindowDisplayLabel(d)).toBe('W-42');
  });

  it('tmuxTarget のみでラベルがフォーマットされる', () => {
    const d = resolveWindowDisplay({ tmuxTarget: 'sess:win' });
    expect(formatWindowDisplayLabel(d)).toBe('sess:win');
  });

  it('同じ windowId で異なるサーバーの窓が正しくラベル表示される', () => {
    // Both servers have windowId 10 but different worker types
    const displayA = resolveWindowDisplay({
      windowId: 10,
      workerType: 'claude',
      tmuxTarget: 'azito:win--a',
    });
    const displayB = resolveWindowDisplay({
      windowId: 10,
      workerType: 'codex',
      tmuxTarget: 'azito:win--b',
    });
    expect(formatWindowDisplayLabel(displayA)).toBe('Claude · W-10');
    expect(formatWindowDisplayLabel(displayB)).toBe('Codex · W-10');
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

describe('buildWindowIndex', () => {
  const mkWin = (id: number, extra?: Partial<WindowIndexEntry>): WindowIndexEntry => ({
    id,
    serverName: 'local',
    tmuxTarget: `azito:win--${id}`,
    windowType: 'agent',
    ...extra,
  });

  it('別プロジェクトのプロジェクト所有窓が引ける', () => {
    const otherProjectWin = mkWin(10, { workerType: 'claude', label: 'win--ab12' });
    const map = buildWindowIndex(
      [{ windows: [otherProjectWin] }],
      [],
      null,
    );
    expect(map.get(10)).toBe(otherProjectWin);
    expect(map.get(10)?.workerType).toBe('claude');
  });

  it('表示中プロジェクトの値で上書きされる', () => {
    const listVersion = mkWin(5, { label: 'stale' });
    const detailVersion = mkWin(5, { label: 'fresh' });
    const map = buildWindowIndex(
      [{ windows: [listVersion] }],
      [],
      { windows: [detailVersion] },
    );
    expect(map.get(5)?.label).toBe('fresh');
  });

  it('タスク所有窓も含まれる', () => {
    const taskWin = mkWin(20, { workerType: 'codex' });
    const map = buildWindowIndex([], [{ windows: [taskWin] }], null);
    expect(map.get(20)?.workerType).toBe('codex');
  });
});
