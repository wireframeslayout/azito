import { describe, it, expect } from 'vitest';
import { stripPaneSuffix, isSameWindowTarget, findByWindowTarget } from './tmuxTarget';

describe('stripPaneSuffix', () => {
  it('removes a trailing pane index', () => {
    expect(stripPaneSuffix('session:window.1')).toBe('session:window');
  });

  it('removes a multi-digit trailing pane index', () => {
    expect(stripPaneSuffix('session:window.12')).toBe('session:window');
  });

  it('leaves a target without a pane suffix unchanged', () => {
    expect(stripPaneSuffix('session:window')).toBe('session:window');
  });

  it('does not strip a dot that is part of the window name itself', () => {
    expect(stripPaneSuffix('session:my.window')).toBe('session:my.window');
  });

  it('only strips the final numeric suffix, not an earlier one', () => {
    expect(stripPaneSuffix('session:my.1window.2')).toBe('session:my.1window');
  });
});

describe('isSameWindowTarget', () => {
  it('treats a bare target and its pane-suffixed form as the same window', () => {
    expect(isSameWindowTarget('session:window', 'session:window.1')).toBe(true);
  });

  it('treats two different pane suffixes of the same window as the same window', () => {
    expect(isSameWindowTarget('session:window.1', 'session:window.2')).toBe(true);
  });

  it('treats different windows as different', () => {
    expect(isSameWindowTarget('session:window1', 'session:window2')).toBe(false);
  });
});

describe('findByWindowTarget', () => {
  // 稼働ソースは pane サフィックス除去済みの target を配信するが、呼び出し側が持つのは
  // windows テーブルの tmuxTarget（タスクウィンドウは `.1` 付き）。両者が引き合えることが
  // インジケータ／完了表示が出る条件（Issue #338）。
  const activityEntries = [
    { serverName: 'local', target: 'test:win--1m1u', status: 'working' as const },
    { serverName: 'local', target: 'main:0', status: 'blocked' as const },
  ];
  const finishedEntries = [
    { serverName: 'local', target: 'test:win--1m1u', finishedAt: 1000 },
  ];

  it('finds an activity entry for a pane-suffixed window target', () => {
    expect(findByWindowTarget(activityEntries, 'local', 'test:win--1m1u.1')?.status).toBe('working');
  });

  it('finds a finished entry for a pane-suffixed window target', () => {
    expect(findByWindowTarget(finishedEntries, 'local', 'test:win--1m1u.1')?.finishedAt).toBe(1000);
  });

  it('still finds an entry when the caller passes the bare target', () => {
    expect(findByWindowTarget(activityEntries, 'local', 'test:win--1m1u')?.status).toBe('working');
  });

  it('matches across differing pane suffixes on both sides', () => {
    const entries = [{ serverName: 'local', target: 'main:0.1' }];
    expect(findByWindowTarget(entries, 'local', 'main:0.2')).toBeDefined();
  });

  it('does not match a different server', () => {
    expect(findByWindowTarget(activityEntries, 'remote', 'test:win--1m1u.1')).toBeUndefined();
  });

  it('does not match a different window', () => {
    expect(findByWindowTarget(activityEntries, 'local', 'test:win--other.1')).toBeUndefined();
  });

  it('accepts any iterable, including a Map values() view', () => {
    const map = new Map(activityEntries.map((e) => [`${e.serverName}::${e.target}`, e]));
    expect(findByWindowTarget(map.values(), 'local', 'main:0.3')?.status).toBe('blocked');
  });
});
