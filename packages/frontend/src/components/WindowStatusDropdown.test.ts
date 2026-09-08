import { describe, expect, it } from 'vitest';
import { findWindow, isTaskOwnedWindow } from './WindowStatusDropdown';
import type { Project, Task, Window } from '../pages/workspace/types';
import type { TerminalRef } from '../lib/terminalRef';

function makeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 1,
    ownerType: 'task',
    taskId: 5,
    serverName: 'srv-a',
    tmuxTarget: 'session:0',
    isPrimary: true,
    windowType: 'terminal',
    ...overrides,
  } as Window;
}

describe('isTaskOwnedWindow', () => {
  it('ownerType=task かつ taskId ありなら true', () => {
    expect(isTaskOwnedWindow(makeWindow({ ownerType: 'task', taskId: 5 }))).toBe(true);
  });

  it('ownerType=project なら false', () => {
    expect(isTaskOwnedWindow(makeWindow({ ownerType: 'project', taskId: undefined, projectId: 3 }))).toBe(false);
  });

  it('ownerType=task でも taskId が無ければ false', () => {
    expect(isTaskOwnedWindow(makeWindow({ ownerType: 'task', taskId: undefined }))).toBe(false);
  });

  it('null/undefined は false', () => {
    expect(isTaskOwnedWindow(null)).toBe(false);
    expect(isTaskOwnedWindow(undefined)).toBe(false);
  });
});

describe('findWindow', () => {
  const taskWindow = makeWindow({ id: 10, ownerType: 'task', taskId: 5, serverName: 'srv-a', tmuxTarget: 'sess:2' });
  const projectWindow = makeWindow({ id: 11, ownerType: 'project', taskId: undefined, projectId: 7, serverName: 'srv-a', tmuxTarget: 'sess:1' });
  const project = { windows: [projectWindow] } as unknown as Project;
  const allTasks = [{ id: 5, windows: [taskWindow] } as unknown as Task];

  it('project.windows から一致するウィンドウを返す', () => {
    expect(findWindow('srv-a', 'sess:1', project, allTasks)).toBe(projectWindow);
  });

  it('project 側に無ければ task 側を探す（タスク所有ウィンドウは project.windows に入らない）', () => {
    expect(findWindow('srv-a', 'sess:2', project, allTasks)).toBe(taskWindow);
  });

  it('pane suffix (.0 等) を無視してベースの window だけで一致させる', () => {
    expect(findWindow('srv-a', 'sess:2.0', project, allTasks)).toBe(taskWindow);
  });

  it('一致しなければ null', () => {
    expect(findWindow('srv-a', 'sess:99', project, allTasks)).toBeNull();
  });

  it('windowId ref で Window.id と照合する', () => {
    const ref: TerminalRef = { kind: 'windowId', serverName: 'srv-a', windowId: 10, pane: 1 };
    expect(findWindow('srv-a', '', project, allTasks, ref)).toBe(taskWindow);
  });

  it('muxRef ref で Window.muxRef と照合する', () => {
    const muxRef = '{"kind":"tmux","workspace":"sess","window":"1"}';
    const winWithMuxRef = makeWindow({ id: 11, serverName: 'srv-a', tmuxTarget: 'sess:1', muxRef });
    const proj = { windows: [winWithMuxRef] } as unknown as Project;
    const ref: TerminalRef = { kind: 'ref', serverName: 'srv-a', ref: muxRef, pane: 1 };
    expect(findWindow('srv-a', '', proj, [], ref)).toBe(winWithMuxRef);
  });

  it('terminalRef で見つからなくても tmuxTarget フォールバックで見つかる', () => {
    const ref: TerminalRef = { kind: 'windowId', serverName: 'srv-a', windowId: 999, pane: 1 };
    expect(findWindow('srv-a', 'sess:1', project, allTasks, ref)).toBe(projectWindow);
  });
});
