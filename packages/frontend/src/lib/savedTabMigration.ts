/**
 * One step of the migrations that rewrite saved tabs once what they need is known (legacy terminal ids, merged server
 * names, Windows file paths). `idMap` is old id -> new id; `dropped` are the ids the step removed without a successor.
 */
export interface TabMigrationStep<T> {
  (tabs: T[]): { tabs: T[]; changed: boolean; idMap: Map<string, string>; dropped?: Set<string> };
}

/** `first` followed by `second`: an id the first step renamed ends where the second step sent it. */
export function composeIdMaps(first: ReadonlyMap<string, string>, second: ReadonlyMap<string, string>): Map<string, string> {
  const composed = new Map<string, string>();
  const renamedByFirst = new Set<string>();
  for (const [from, to] of first) {
    renamedByFirst.add(to);
    composed.set(from, second.get(to) ?? to);
  }
  for (const [from, to] of second) {
    if (!renamedByFirst.has(from)) composed.set(from, to);
  }
  return composed;
}

/**
 * Runs the steps in order, each on the previous step's tabs, and returns the final tabs with one id map from the ids
 * the tabs started with. The caller applies that once to the active tab and the pane layout, so no step's result can be
 * overwritten by another's.
 */
export function composeTabMigrations<T>(
  tabs: T[],
  steps: ReadonlyArray<TabMigrationStep<T>>,
): { tabs: T[]; changed: boolean; idMap: Map<string, string>; dropped: Set<string> } {
  let current = tabs;
  let changed = false;
  let idMap = new Map<string, string>();
  const dropped = new Set<string>();
  for (const step of steps) {
    const result = step(current);
    if (!result.changed) continue;
    changed = true;
    current = result.tabs;
    idMap = composeIdMaps(idMap, result.idMap);
    result.dropped?.forEach((id) => dropped.add(id));
  }
  return { tabs: current, changed, idMap, dropped };
}
