import { describe, it, expect } from 'vitest';
import { buildObjectSections } from './workspaceObjects';
import type { Window } from '../pages/workspace/types';

function makeWindow(overrides: Partial<Window> & { serverName: string; tmuxTarget: string }): Window {
  return {
    id: 1,
    ownerType: 'project',
    isPrimary: false,
    windowType: 'terminal',
    ...overrides,
  };
}

describe('buildObjectSections', () => {
  it('separates ownerType=task into operationWindows', () => {
    const windows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'main:1', ownerType: 'project' }),
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'main:2', ownerType: 'task', taskId: 10 }),
    ];
    const result = buildObjectSections(windows, [], [], {}, ['srv1']);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].id).toBe(1);
    expect(result.operationWindows).toHaveLength(1);
    expect(result.operationWindows[0].id).toBe(2);
  });

  it('separates windows resolved via taskWindows into operationWindows', () => {
    const windows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'main:1', ownerType: 'project' }),
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'main:2', ownerType: 'project' }),
    ];
    const taskWindows = [{ serverName: 'srv1', tmuxTarget: 'main:2', taskId: 20 }];
    const result = buildObjectSections(windows, taskWindows, [], {}, ['srv1']);
    expect(result.windows).toHaveLength(1);
    expect(result.operationWindows).toHaveLength(1);
    expect(result.operationWindows[0].taskId).toBe(20);
  });

  it('includes task-owned windows (ownerType=task, not present in project.windows) in operationWindows', () => {
    // Task-owned windows live outside project.windows (project_id is NULL for them server-side),
    // so they arrive as a separate list built from the current project's tasks.
    const projectWindows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'main:1', ownerType: 'project' }),
    ];
    const taskOwnedWindows = [
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'task', taskId: 30 }),
    ];
    const result = buildObjectSections(projectWindows, [], taskOwnedWindows, {}, ['srv1']);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].id).toBe(1);
    expect(result.operationWindows).toHaveLength(1);
    expect(result.operationWindows[0].id).toBe(2);
    expect(result.operationWindows[0].taskId).toBe(30);
  });

  it('dedupes a task-owned window that also resolves via taskWindows against the same target, preferring the task-owned entity', () => {
    const projectWindows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'project' }),
    ];
    const taskWindows = [{ serverName: 'srv1', tmuxTarget: 'agent:1', taskId: 40 }];
    const taskOwnedWindows = [
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'task', taskId: 40, workerType: 'claude' }),
    ];
    const result = buildObjectSections(projectWindows, taskWindows, taskOwnedWindows, {}, ['srv1']);
    expect(result.operationWindows).toHaveLength(1);
    expect(result.operationWindows[0].id).toBe(2);
    expect(result.operationWindows[0].workerType).toBe('claude');
  });

  it('dedupes a task-owned window against a pane-suffixed target (pane suffix stripped for comparison)', () => {
    const taskOwnedWindows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'agent:1.1', ownerType: 'task', taskId: 50 }),
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'task', taskId: 50 }),
    ];
    const result = buildObjectSections([], [], taskOwnedWindows, {}, ['srv1']);
    expect(result.operationWindows).toHaveLength(1);
  });

  it('does not collapse two different tasks that own the same physical window (server+target), keeping both rows with correct task attribution', () => {
    // Task windows have no uniqueness constraint on (serverName, tmuxTarget) — two tasks can
    // register a row against the same physical tmux window. Dedup must key on taskId too, or
    // the later-inserted row silently wins and clicks/context-menus resolve to the wrong task.
    const taskOwnedWindows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'task', taskId: 60, workerType: 'claude' }),
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'task', taskId: 61, workerType: 'codex' }),
    ];
    const result = buildObjectSections([], [], taskOwnedWindows, {}, ['srv1']);
    expect(result.operationWindows).toHaveLength(2);
    const byTaskId = new Map(result.operationWindows.map((w) => [w.taskId, w]));
    expect(byTaskId.get(60)?.id).toBe(1);
    expect(byTaskId.get(60)?.workerType).toBe('claude');
    expect(byTaskId.get(61)?.id).toBe(2);
    expect(byTaskId.get(61)?.workerType).toBe('codex');
  });

  it('does not collapse a project-side mirror row against a task-owned row when they resolve to different tasks', () => {
    // project.windows resolves taskId=70 via taskWindows for this target, but a *different* task (71)
    // separately registered a task-owned window against the same physical window. Both must survive.
    const projectWindows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'project' }),
    ];
    const taskWindows = [{ serverName: 'srv1', tmuxTarget: 'agent:1', taskId: 70 }];
    const taskOwnedWindows = [
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'task', taskId: 71 }),
    ];
    const result = buildObjectSections(projectWindows, taskWindows, taskOwnedWindows, {}, ['srv1']);
    expect(result.operationWindows).toHaveLength(2);
    const taskIds = result.operationWindows.map((w) => w.taskId).sort();
    expect(taskIds).toEqual([70, 71]);
  });

  it('sorts operationWindows by taskId then label then id for a stable order', () => {
    const taskOwnedWindows = [
      makeWindow({ id: 3, serverName: 'srv1', tmuxTarget: 'agent:3', ownerType: 'task', taskId: 20, label: 'b' }),
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'agent:1', ownerType: 'task', taskId: 10, label: 'z' }),
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'agent:2', ownerType: 'task', taskId: 20, label: 'a' }),
    ];
    const result = buildObjectSections([], [], taskOwnedWindows, {}, ['srv1']);
    expect(result.operationWindows.map((w) => w.id)).toEqual([1, 2, 3]);
  });

  it('excludes browsers from non-project servers', () => {
    const browserGroups = {
      srv1: [{ groupId: 'g1', pageCount: 2, urls: ['https://a.com', null] }],
      srv2: [{ groupId: 'g2', pageCount: 1, urls: ['https://b.com'] }],
    };
    const result = buildObjectSections([], [], [], browserGroups, ['srv1']);
    expect(result.browsers).toHaveLength(1);
    expect(result.browsers[0].serverName).toBe('srv1');
  });

  it('computes totalCount as sum of all three sections', () => {
    const windows = [
      makeWindow({ id: 1, serverName: 'srv1', tmuxTarget: 'main:1', ownerType: 'project' }),
      makeWindow({ id: 2, serverName: 'srv1', tmuxTarget: 'main:2', ownerType: 'task', taskId: 5 }),
    ];
    const browserGroups = {
      srv1: [{ groupId: 'g1', pageCount: 1, urls: ['https://x.com'] }],
    };
    const result = buildObjectSections(windows, [], [], browserGroups, ['srv1']);
    expect(result.totalCount).toBe(3);
  });

  it('extracts primaryUrl from first non-null url', () => {
    const browserGroups = {
      srv1: [{ groupId: 'g1', pageCount: 3, urls: [null, 'https://first.com', 'https://second.com'] }],
    };
    const result = buildObjectSections([], [], [], browserGroups, ['srv1']);
    expect(result.browsers[0].primaryUrl).toBe('https://first.com');
  });

  it('returns null primaryUrl when all urls are null', () => {
    const browserGroups = {
      srv1: [{ groupId: 'g1', pageCount: 1, urls: [null] }],
    };
    const result = buildObjectSections([], [], [], browserGroups, ['srv1']);
    expect(result.browsers[0].primaryUrl).toBeNull();
  });
});
