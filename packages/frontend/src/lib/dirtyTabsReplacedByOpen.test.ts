import { describe, expect, it } from 'vitest';
import { dirtyTabsReplacedByOpen } from './dirtyTabsReplacedByOpen';

describe('dirtyTabsReplacedByOpen', () => {
  it('reports a dirty unpinned tab even when a pinned tab is active', () => {
    const tabs = [{ id: 'pinned', pinned: true }, { id: 'file:a', dirty: true }];
    expect(dirtyTabsReplacedByOpen(tabs, 'file:b').map((tab) => tab.id)).toEqual(['file:a']);
  });
  it('ignores dirty pinned tabs, which opening keeps', () => {
    expect(dirtyTabsReplacedByOpen([{ id: 'file:a', dirty: true, pinned: true }], 'file:b')).toEqual([]);
  });
  it('discards nothing when the target is already open', () => {
    expect(dirtyTabsReplacedByOpen([{ id: 'file:a', dirty: true }, { id: 'file:b' }], 'file:b')).toEqual([]);
  });
});
