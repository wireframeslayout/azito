import { describe, it, expect } from 'vitest';
import { buildTabGroups, buildPinnedItems } from './mobileTabGroups';
import type { PersistedTab } from '../../hooks/useTabPersistence';
import type { TabItem } from '../ui';

const UNGROUPED = 'Ungrouped';

function tab(id: string, projectId?: number, pinned?: boolean): PersistedTab {
  return { id, type: 'terminal', label: id, projectId, pinned };
}

function buildTabItem(t: PersistedTab): TabItem {
  return { id: t.id, label: t.label };
}

describe('buildTabGroups', () => {
  it('orders known-project groups following allProjects order', () => {
    const tabs = [tab('a', 2), tab('b', 1)];
    const allProjects = [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }];
    const groups = buildTabGroups(tabs, allProjects, buildTabItem, UNGROUPED);
    expect(groups.map((g) => g.projectId)).toEqual([1, 2]);
    expect(groups[0].name).toBe('One');
    expect(groups[1].name).toBe('Two');
  });

  it('keeps a tab with no projectId visible as an ungrouped fallback group', () => {
    const tabs = [tab('a')];
    const groups = buildTabGroups(tabs, [], buildTabItem, UNGROUPED);
    expect(groups).toHaveLength(1);
    expect(groups[0].projectId).toBeNull();
    expect(groups[0].name).toBe(UNGROUPED);
    expect(groups[0].items.map((i) => i.tab.id)).toEqual(['a']);
  });

  it('does not drop a tab whose projectId is unknown (deleted/not-yet-loaded project)', () => {
    const tabs = [tab('a', 999), tab('b', 1)];
    const allProjects = [{ id: 1, name: 'One' }];
    const groups = buildTabGroups(tabs, allProjects, buildTabItem, UNGROUPED);
    // Both the known-project group and the unknown-project fallback group must be present.
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.projectId).sort()).toEqual([1, 999].sort());
    const unknownGroup = groups.find((g) => g.projectId === 999);
    expect(unknownGroup).toBeDefined();
    expect(unknownGroup!.name).toBe(UNGROUPED);
    expect(unknownGroup!.items.map((i) => i.tab.id)).toEqual(['a']);
  });

  it('keeps unknown-project tabs and null-projectId tabs as separate fallback groups', () => {
    const tabs = [tab('a', 999), tab('b')];
    const groups = buildTabGroups(tabs, [], buildTabItem, UNGROUPED);
    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.projectId);
    expect(ids).toContain(999);
    expect(ids).toContain(null);
  });

  it('returns an empty list when there are no tabs', () => {
    const groups = buildTabGroups([], [{ id: 1, name: 'One' }], buildTabItem, UNGROUPED);
    expect(groups).toEqual([]);
  });

  it('excludes pinned tabs from group items but still counts them in totalCount', () => {
    const tabs = [tab('a', 1, true), tab('b', 1)];
    const allProjects = [{ id: 1, name: 'One' }];
    const groups = buildTabGroups(tabs, allProjects, buildTabItem, UNGROUPED);
    expect(groups).toHaveLength(1);
    expect(groups[0].totalCount).toBe(2);
    expect(groups[0].items.map((i) => i.tab.id)).toEqual(['b']);
  });
});

describe('buildPinnedItems', () => {
  it('returns only pinned tabs, in tabs-array order, across projects', () => {
    const tabs = [tab('a', 2), tab('b', 1, true), tab('c', 2, true), tab('d')];
    const allProjects = [{ id: 1, name: 'One', color: '#111' }, { id: 2, name: 'Two', color: '#222' }];
    const pinned = buildPinnedItems(tabs, allProjects, buildTabItem);
    expect(pinned.map((p) => p.tab.id)).toEqual(['b', 'c']);
    expect(pinned[0].color).toBe('#111');
    expect(pinned[1].color).toBe('#222');
  });

  it('returns an empty list when no tabs are pinned', () => {
    const pinned = buildPinnedItems([tab('a', 1)], [{ id: 1, name: 'One' }], buildTabItem);
    expect(pinned).toEqual([]);
  });
});
