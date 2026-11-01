import { describe, expect, it } from 'vitest';
import { recentItems } from './recentItems';
import type { SearchItem } from './searchIndex';

describe('recentItems', () => {
  it('orders active windows, the five most recent tasks, and recent projects', () => {
    const item = (id: number, kind: SearchItem['kind'], recent = 0): SearchItem => ({ id, kind, recent, title: String(id), projectId: 1, projectName: 'p', fields: [], active: kind === 'window', ...(kind === 'window' ? { window: {} as SearchItem['window'] } : {}) });
    const items = [item(9, 'project'), ...Array.from({ length: 7 }, (_, i) => item(i + 1, 'task', i + 1)), item(20, 'window')];
    expect(recentItems(items, [9]).map(result => result.id)).toEqual([20, 7, 6, 5, 4, 3, 9]);
    expect(recentItems([], [])).toEqual([]);
  });
});
