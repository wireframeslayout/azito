interface TabDirtyState {
  id: string;
  pinned?: boolean;
  dirty?: boolean;
}

/** Opening a tab that is not already open replaces every unpinned tab; returns the dirty ones it would discard. */
export function dirtyTabsReplacedByOpen<T extends TabDirtyState>(tabs: readonly T[], targetId: string): T[] {
  if (tabs.some((tab) => tab.id === targetId)) return [];
  return tabs.filter((tab) => tab.dirty && !tab.pinned);
}
