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
    const result = buildObjectSections(windows, [], {}, ['srv1']);
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
    const result = buildObjectSections(windows, taskWindows, {}, ['srv1']);
    expect(result.windows).toHaveLength(1);
    expect(result.operationWindows).toHaveLength(1);
    expect(result.operationWindows[0].taskId).toBe(20);
  });

  it('excludes browsers from non-project servers', () => {
    const browserGroups = {
      srv1: [{ groupId: 'g1', pageCount: 2, urls: ['https://a.com', null] }],
      srv2: [{ groupId: 'g2', pageCount: 1, urls: ['https://b.com'] }],
    };
    const result = buildObjectSections([], [], browserGroups, ['srv1']);
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
    const result = buildObjectSections(windows, [], browserGroups, ['srv1']);
    expect(result.totalCount).toBe(3);
  });

  it('extracts primaryUrl from first non-null url', () => {
    const browserGroups = {
      srv1: [{ groupId: 'g1', pageCount: 3, urls: [null, 'https://first.com', 'https://second.com'] }],
    };
    const result = buildObjectSections([], [], browserGroups, ['srv1']);
    expect(result.browsers[0].primaryUrl).toBe('https://first.com');
  });

  it('returns null primaryUrl when all urls are null', () => {
    const browserGroups = {
      srv1: [{ groupId: 'g1', pageCount: 1, urls: [null] }],
    };
    const result = buildObjectSections([], [], browserGroups, ['srv1']);
    expect(result.browsers[0].primaryUrl).toBeNull();
  });
});
