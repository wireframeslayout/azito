/**
 * One step of the migrations that rewrite saved tabs once what they need is known (legacy terminal ids, merged server
 * names, Windows file paths). `idMap` is old id -> new id; `dropped` are the ids the step removed without a successor.
 */
export interface TabMigrationStep<T> {
  (tabs: T[]): { tabs: T[]; changed: boolean; idMap: Map<string, string>; dropped?: Set<string> };
}

/**
 * Runs the steps in order, each on the previous step's tabs, and returns the final tabs with one id map from every id
 * the tabs started with to the id it ended as (a tab folded into another one maps to the survivor, whichever of the two
 * it was, so the active tab and the pane layout find it). The caller applies that once to the active tab and the pane
 * layout, so no step's result can be overwritten by another's. Ids that did not change are not in the map.
 */
export function composeTabMigrations<T extends { id: string }>(
  tabs: T[],
  steps: ReadonlyArray<TabMigrationStep<T>>,
): { tabs: T[]; changed: boolean; idMap: Map<string, string>; dropped: Set<string> } {
  let current = tabs;
  let changed = false;
  // Every starting id -> the id it has now (null: dropped).
  const now = new Map<string, string | null>(tabs.map((tab) => [tab.id, tab.id]));
  for (const step of steps) {
    const result = step(current);
    if (!result.changed) continue;
    changed = true;
    current = result.tabs;
    for (const [original, id] of now) {
      if (id === null) continue;
      now.set(original, result.dropped?.has(id) ? null : (result.idMap.get(id) ?? id));
    }
  }
  const idMap = new Map<string, string>();
  const dropped = new Set<string>();
  for (const [original, id] of now) {
    if (id === null) dropped.add(original);
    else if (id !== original) idMap.set(original, id);
  }
  return { tabs: current, changed, idMap, dropped };
}
