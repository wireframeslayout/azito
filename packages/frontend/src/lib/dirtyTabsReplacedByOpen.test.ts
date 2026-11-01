import { describe, expect, it } from 'vitest';
import { dirtyTabsReplacedByOpen, tabsKeptByOpen } from './dirtyTabsReplacedByOpen';

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

describe('tabsKeptByOpen', () => {
  it('keeps pinned tabs and dirty tabs whose discarding was not confirmed', () => {
    const tabs = [{ id: 'pinned', pinned: true }, { id: 'clean' }, { id: 'confirmed', dirty: true }, { id: 'late', dirty: true }];
    expect(tabsKeptByOpen(tabs, new Set(['confirmed'])).map((tab) => tab.id)).toEqual(['pinned', 'late']);
  });
});
