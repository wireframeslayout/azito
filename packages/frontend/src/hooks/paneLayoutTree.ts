/**
 * Pure logic for the Workspace multi-pane split layout (Issue #397).
 *
 * The layout is a binary tree: leaves are `PaneNode`s holding a list of tab
 * ids, internal nodes are `SplitNode`s dividing their two children `a`/`b`
 * along a `row` (horizontal split, side-by-side) or `col` (vertical split,
 * stacked) direction. `ratio` is the fractional size of `a` (0.15-0.85).
 *
 * Every exported function is immutable: none of them mutate the tree they
 * are given, they always return a (possibly structurally-shared) new tree.
 * React components (see usePaneLayout.ts) own the mutable state; this module
 * has no React dependency.
 */

export interface PaneNode {
  type: 'pane';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SplitNode {
  type: 'split';
  dir: 'row' | 'col';
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export type DropZone = 'tabbar' | 'center' | 'left' | 'right' | 'top' | 'bottom';

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

// Monotonic counter for pane ids. A counter (not Date.now()/Math.random()) so
// ids stay short, readable, and deterministic within a single session.
let paneIdCounter = 0;

export function createPane(tabIds: string[] = [], activeTabId?: string | null): PaneNode {
  paneIdCounter += 1;
  const resolvedActive = activeTabId !== undefined
    ? activeTabId
    : (tabIds.length > 0 ? tabIds[tabIds.length - 1] : null);
  return { type: 'pane', id: `p${paneIdCounter}`, tabIds: [...tabIds], activeTabId: resolvedActive };
}

export function listPanes(root: LayoutNode): PaneNode[] {
  if (root.type === 'pane') return [root];
  return [...listPanes(root.a), ...listPanes(root.b)];
}

export function findPane(root: LayoutNode, paneId: string): PaneNode | null {
  if (root.type === 'pane') return root.id === paneId ? root : null;
  return findPane(root.a, paneId) ?? findPane(root.b, paneId);
}

export function findPaneByTab(root: LayoutNode, tabId: string): PaneNode | null {
  if (root.type === 'pane') return root.tabIds.includes(tabId) ? root : null;
  return findPaneByTab(root.a, tabId) ?? findPaneByTab(root.b, tabId);
}

/**
 * Replaces the pane matching `paneId` with the node produced by `replacement`.
 * Returns the same node reference for unaffected subtrees, so callers can
 * detect "nothing changed" via `===`.
 */
function replacePane(node: LayoutNode, paneId: string, replacement: (pane: PaneNode) => LayoutNode): LayoutNode {
  if (node.type === 'pane') {
    return node.id === paneId ? replacement(node) : node;
  }
  const a = replacePane(node.a, paneId, replacement);
  const b = replacePane(node.b, paneId, replacement);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/** Folds a split node into its surviving sibling once its pane child matches `paneId`. */
function collapsePane(node: LayoutNode, paneId: string): LayoutNode {
  if (node.type === 'pane') return node;
  if (node.a.type === 'pane' && node.a.id === paneId) return node.b;
  if (node.b.type === 'pane' && node.b.id === paneId) return node.a;
  const a = collapsePane(node.a, paneId);
  const b = collapsePane(node.b, paneId);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/**
 * Removes a pane from the tree, folding its parent split into the sibling.
 * A no-op if `root` is itself the single remaining pane (nothing to fold
 * into) or if `paneId` does not exist in the tree.
 */
export function removePane(root: LayoutNode, paneId: string): LayoutNode {
  if (root.type === 'pane') return root;
  if (!findPane(root, paneId)) return root;
  return collapsePane(root, paneId);
}

export function setActiveTab(root: LayoutNode, paneId: string, tabId: string): LayoutNode {
  const pane = findPane(root, paneId);
  if (!pane) throw new Error(`setActiveTab: pane not found: ${paneId}`);
  if (!pane.tabIds.includes(tabId)) throw new Error(`setActiveTab: tab ${tabId} not in pane ${paneId}`);
  if (pane.activeTabId === tabId) return root;
  return replacePane(root, paneId, (p) => ({ ...p, activeTabId: tabId }));
}

export function splitPane(
  root: LayoutNode,
  targetPaneId: string,
  zone: 'left' | 'right' | 'top' | 'bottom',
  tabId: string | null,
  fromPaneId: string | null,
): LayoutNode {
  const targetPane = findPane(root, targetPaneId);
  if (!targetPane) throw new Error(`splitPane: pane not found: ${targetPaneId}`);

  // Self-splitting a pane that holds only one tab produces an empty pane on the
  // "remaining" side — this is allowed, not a no-op: the empty pane is a first-class
  // state (reconcile() preserves an originally-empty pane, SplitLayoutPane renders a
  // placeholder for it, and its trailing ✕ closes it), so a context-menu "split
  // right/down" or an edge drop on a single-tab pane must still produce a visible split
  // instead of silently doing nothing.
  let workingRoot = root;
  let remainingTabIds = targetPane.tabIds;
  let remainingActiveTabId = targetPane.activeTabId;

  if (fromPaneId !== null && tabId !== null) {
    const fromPane = findPane(workingRoot, fromPaneId);
    if (!fromPane) throw new Error(`splitPane: source pane not found: ${fromPaneId}`);
    if (!fromPane.tabIds.includes(tabId)) throw new Error(`splitPane: tab ${tabId} not in pane ${fromPaneId}`);

    if (fromPaneId === targetPaneId) {
      // Detaching from the pane being split: shrink the "remaining" side in place.
      remainingTabIds = fromPane.tabIds.filter((t) => t !== tabId);
      remainingActiveTabId = fromPane.activeTabId === tabId
        ? (remainingTabIds.length > 0 ? remainingTabIds[remainingTabIds.length - 1] : null)
        : fromPane.activeTabId;
    } else {
      const newFromTabIds = fromPane.tabIds.filter((t) => t !== tabId);
      const newFromActiveTabId = fromPane.activeTabId === tabId
        ? (newFromTabIds.length > 0 ? newFromTabIds[newFromTabIds.length - 1] : null)
        : fromPane.activeTabId;

      workingRoot = newFromTabIds.length === 0
        ? removePane(workingRoot, fromPaneId)
        : replacePane(workingRoot, fromPaneId, (pane) => ({ ...pane, tabIds: newFromTabIds, activeTabId: newFromActiveTabId }));
    }
  }

  const remainingPane: PaneNode = { type: 'pane', id: targetPaneId, tabIds: remainingTabIds, activeTabId: remainingActiveTabId };
  const newPane: PaneNode = tabId !== null ? createPane([tabId], tabId) : createPane([], null);

  const dir: 'row' | 'col' = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const newPaneIsFirst = zone === 'left' || zone === 'top';
  const splitNode: SplitNode = {
    type: 'split',
    dir,
    ratio: 0.5,
    a: newPaneIsFirst ? newPane : remainingPane,
    b: newPaneIsFirst ? remainingPane : newPane,
  };

  return replacePane(workingRoot, targetPaneId, () => splitNode);
}

/**
 * Moves `tabId` from `fromPaneId` to `toPaneId`, optionally inserting at
 * `index`.
 *
 * For a same-pane reorder (`fromPaneId === toPaneId`), `index` is interpreted
 * against the pane's *current* tab array (i.e. including `tabId` itself at
 * its current position) — the position callers naturally compute from a live
 * tab strip's DOM order. Internally this is translated to an index into the
 * array with `tabId` removed: when `index` is past the tab's current
 * position, it is decremented by one to compensate for the removal shifting
 * everything after it left by one slot.
 *
 * For a cross-pane move, `index` is interpreted against the destination
 * pane's tab array as-is (the moved tab is not yet present there).
 */
export function moveTab(root: LayoutNode, tabId: string, fromPaneId: string, toPaneId: string, index?: number): LayoutNode {
  const fromPane = findPane(root, fromPaneId);
  if (!fromPane) throw new Error(`moveTab: source pane not found: ${fromPaneId}`);
  if (!fromPane.tabIds.includes(tabId)) throw new Error(`moveTab: tab ${tabId} not in pane ${fromPaneId}`);

  if (fromPaneId === toPaneId) {
    if (index === undefined) return setActiveTab(root, fromPaneId, tabId);
    const currentIndex = fromPane.tabIds.indexOf(tabId);
    // Pre-removal insertion positions range over the whole array, including
    // one-past-the-end (== "drop after the last tab").
    const clampedIndex = Math.max(0, Math.min(index, fromPane.tabIds.length));
    const adjustedIndex = clampedIndex > currentIndex ? clampedIndex - 1 : clampedIndex;
    const remaining = fromPane.tabIds.filter((t) => t !== tabId);
    remaining.splice(adjustedIndex, 0, tabId);
    return replacePane(root, fromPaneId, (pane) => ({ ...pane, tabIds: remaining, activeTabId: tabId }));
  }

  const toPane = findPane(root, toPaneId);
  if (!toPane) throw new Error(`moveTab: destination pane not found: ${toPaneId}`);

  const newFromTabIds = fromPane.tabIds.filter((t) => t !== tabId);
  const newFromActiveTabId = fromPane.activeTabId === tabId
    ? (newFromTabIds.length > 0 ? newFromTabIds[newFromTabIds.length - 1] : null)
    : fromPane.activeTabId;

  let workingRoot = newFromTabIds.length === 0
    ? removePane(root, fromPaneId)
    : replacePane(root, fromPaneId, (pane) => ({ ...pane, tabIds: newFromTabIds, activeTabId: newFromActiveTabId }));

  workingRoot = replacePane(workingRoot, toPaneId, (pane) => {
    const newTabIds = [...pane.tabIds];
    const insertIndex = index === undefined ? newTabIds.length : Math.max(0, Math.min(index, newTabIds.length));
    newTabIds.splice(insertIndex, 0, tabId);
    return { ...pane, tabIds: newTabIds, activeTabId: tabId };
  });

  return workingRoot;
}

/**
 * Returns the id of the pane "after" `paneId` in `listPanes()` order,
 * wrapping from the last pane back to the first. Returns `null` when
 * `paneId` isn't in the tree, or when it is the only pane (nothing to wrap
 * to). Callers that need to know the destination of a moveTabToNextPane()/
 * mergePaneIntoNext() call *before* running it (e.g. to focus the
 * destination pane once the transform is applied, since the source pane may
 * fold away and shift `listPanes()` order) should use this.
 */
export function findNextPaneId(root: LayoutNode, paneId: string): string | null {
  const panes = listPanes(root);
  if (panes.length <= 1) return null;
  const idx = panes.findIndex((p) => p.id === paneId);
  if (idx === -1) return null;
  return panes[(idx + 1) % panes.length].id;
}

export function moveTabToNextPane(root: LayoutNode, paneId: string, tabId: string): LayoutNode {
  if (!findPane(root, paneId)) throw new Error(`moveTabToNextPane: pane not found: ${paneId}`);
  const nextPaneId = findNextPaneId(root, paneId);
  if (nextPaneId === null) return root;
  return moveTab(root, tabId, paneId, nextPaneId);
}

export function mergePaneIntoNext(root: LayoutNode, paneId: string): LayoutNode {
  const panes = listPanes(root);
  if (panes.length <= 1) return root;
  const idx = panes.findIndex((p) => p.id === paneId);
  if (idx === -1) throw new Error(`mergePaneIntoNext: pane not found: ${paneId}`);
  const sourcePane = panes[idx];
  const nextPane = panes[(idx + 1) % panes.length];

  const mergedTabIds = [...nextPane.tabIds];
  for (const t of sourcePane.tabIds) {
    if (!mergedTabIds.includes(t)) mergedTabIds.push(t);
  }
  const mergedActiveTabId = sourcePane.activeTabId ?? nextPane.activeTabId;

  const withMerged = replacePane(root, nextPane.id, (pane) => ({ ...pane, tabIds: mergedTabIds, activeTabId: mergedActiveTabId }));
  return removePane(withMerged, paneId);
}

export function closeTab(root: LayoutNode, paneId: string, tabId: string): LayoutNode {
  const pane = findPane(root, paneId);
  if (!pane) throw new Error(`closeTab: pane not found: ${paneId}`);
  if (!pane.tabIds.includes(tabId)) throw new Error(`closeTab: tab ${tabId} not in pane ${paneId}`);

  const newTabIds = pane.tabIds.filter((t) => t !== tabId);
  const newActiveTabId = pane.activeTabId === tabId
    ? (newTabIds.length > 0 ? newTabIds[newTabIds.length - 1] : null)
    : pane.activeTabId;

  // Empty pane on a multi-pane tree folds away; a lone root pane is kept empty.
  if (newTabIds.length === 0 && root.type !== 'pane') {
    return removePane(root, paneId);
  }
  return replacePane(root, paneId, (p) => ({ ...p, tabIds: newTabIds, activeTabId: newActiveTabId }));
}

export function openTab(root: LayoutNode, tabId: string, preferredPaneId: string | null): { root: LayoutNode; paneId: string } {
  const existing = findPaneByTab(root, tabId);
  if (existing) {
    return { root: setActiveTab(root, existing.id, tabId), paneId: existing.id };
  }

  const panes = listPanes(root);
  const target = (preferredPaneId ? panes.find((p) => p.id === preferredPaneId) : undefined) ?? panes[0];
  if (!target) throw new Error('openTab: layout tree has no panes');

  const newRoot = replacePane(root, target.id, (pane) => ({ ...pane, tabIds: [...pane.tabIds, tabId], activeTabId: tabId }));
  return { root: newRoot, paneId: target.id };
}

export function setRatio(root: LayoutNode, splitPath: string, ratio: number): LayoutNode {
  const clamped = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
  const steps = splitPath === '' ? [] : splitPath.split('');

  function recur(node: LayoutNode, remaining: string[]): LayoutNode {
    if (node.type !== 'split') throw new Error(`setRatio: invalid splitPath: ${splitPath}`);
    if (remaining.length === 0) {
      return node.ratio === clamped ? node : { ...node, ratio: clamped };
    }
    const [step, ...rest] = remaining;
    if (step === 'a') return { ...node, a: recur(node.a, rest) };
    if (step === 'b') return { ...node, b: recur(node.b, rest) };
    throw new Error(`setRatio: invalid splitPath segment: ${step}`);
  }

  return recur(root, steps);
}

/**
 * Drops tabs that no longer exist in `validTabIds`, folding any pane that
 * becomes empty as a result. When `appendMissing` (default true) is set,
 * tabs present in `validTabIds` but missing from the tree (e.g. a
 * newly-opened tab) are appended to `preferredPaneId`'s pane when given and
 * still present after pruning, otherwise to the first pane. If every pane
 * ends up empty, returns a single empty pane.
 *
 * `appendMissing: false` is for callers whose `validTabIds` means "tabs
 * available to open" rather than "tabs the user currently has open" (e.g.
 * TaskPanel's task-scoped tab set, where a fixed view or window tab a user
 * explicitly closed must stay closed even though it's still a valid tab id)
 * — only the prune half runs, so a tab that becomes invalid (e.g. its window
 * was deleted) is still removed, but nothing is ever auto-reopened.
 *
 * `preferredPaneId` is protected from the empty-pane fold whenever there are
 * missing tabs to place into it — e.g. an intentionally-empty pane (freshly
 * split, or emptied by closing its last tab) that's also the focused pane a
 * sidebar "open" should land in. Without this, prune() would fold that pane
 * away before the missing-tabs step ever sees it, silently falling back to
 * the first pane instead. Never applies when `appendMissing` is false, since
 * no missing tabs are ever placed.
 */
export function reconcile(root: LayoutNode, validTabIds: string[], preferredPaneId: string | null = null, appendMissing = true): LayoutNode {
  const validSet = new Set(validTabIds);

  const presentBeforePrune = new Set(listPanes(root).flatMap((p) => p.tabIds));
  const willHaveMissingTabs = appendMissing && validTabIds.some((t) => !presentBeforePrune.has(t));
  const protectedPaneId = willHaveMissingTabs && preferredPaneId && findPane(root, preferredPaneId)
    ? preferredPaneId
    : null;

  // Only a pane that *became* empty as a result of this prune pass (had tabs before, has
  // none after — 'pruned') is a fold candidate — a pane that was already empty going in
  // (e.g. freshly split via ◫/⬓, or emptied earlier by the user closing its last tab) is
  // an intentional placeholder ('intentional') and must survive reconcile regardless of
  // protectedPaneId, or every empty-pane placeholder would vanish the moment `allTabIds`'s
  // reference changes (e.g. the windows-list poll) or the layout reloads.
  //
  // A shallow "is node.a/node.b itself already an empty pane?" check isn't enough once a
  // split's child is itself a split: that nested split might collapse (its own prune pass
  // folding one of *its* children away) into a single pane that's only empty because of
  // that inner fold, or might collapse into a pane that was an intentionally-empty leaf
  // several levels down — the shallow check can't tell those apart before recursing. So
  // `prune` instead returns which kind of empty (if any) the node it hands back actually
  // is, and every level composes its own answer from its children's answers rather than
  // re-inspecting node shape.
  type EmptyKind = 'none' | 'intentional' | 'pruned';

  function prune(node: LayoutNode): { node: LayoutNode; emptyKind: EmptyKind } {
    if (node.type === 'pane') {
      const tabIds = node.tabIds.filter((t) => validSet.has(t));
      const activeTabId = node.activeTabId !== null && tabIds.includes(node.activeTabId)
        ? node.activeTabId
        : (tabIds.length > 0 ? tabIds[tabIds.length - 1] : null);
      const resultNode = tabIds.length === node.tabIds.length ? node : { ...node, tabIds, activeTabId };
      if (tabIds.length > 0) return { node: resultNode, emptyKind: 'none' };
      return { node: resultNode, emptyKind: node.tabIds.length === 0 ? 'intentional' : 'pruned' };
    }
    const aResult = prune(node.a);
    const bResult = prune(node.b);
    const a = aResult.node;
    const b = bResult.node;
    const aEmpty = a.type === 'pane' && aResult.emptyKind === 'pruned' && a.id !== protectedPaneId;
    const bEmpty = b.type === 'pane' && bResult.emptyKind === 'pruned' && b.id !== protectedPaneId;
    if (aEmpty && bEmpty) return { node: a, emptyKind: aResult.emptyKind };
    if (aEmpty) return { node: b, emptyKind: bResult.emptyKind };
    if (bEmpty) return { node: a, emptyKind: aResult.emptyKind };
    const merged = a === node.a && b === node.b ? node : { ...node, a, b };
    return { node: merged, emptyKind: 'none' };
  }

  let result = prune(root).node;
  if (!appendMissing) return result;

  const presentTabIds = new Set(listPanes(result).flatMap((p) => p.tabIds));
  const missingTabIds = validTabIds.filter((t) => !presentTabIds.has(t));
  if (missingTabIds.length > 0) {
    const preferredPane = preferredPaneId ? findPane(result, preferredPaneId) : null;
    const targetPane = preferredPane ?? listPanes(result)[0];
    result = replacePane(result, targetPane.id, (pane) => ({
      ...pane,
      tabIds: [...pane.tabIds, ...missingTabIds],
      activeTabId: pane.activeTabId ?? missingTabIds[missingTabIds.length - 1],
    }));
  }

  return result;
}

function normalizePaneNode(value: Record<string, unknown>): PaneNode | null {
  const { id, tabIds, activeTabId } = value;
  if (typeof id !== 'string' || id.length === 0) return null;
  // Empty tabIds is a legitimate state (e.g. the sole root pane after the last
  // tab was closed), so only the non-empty case constrains activeTabId below.
  if (!Array.isArray(tabIds)) return null;
  if (!tabIds.every((t): t is string => typeof t === 'string')) return null;
  if (activeTabId !== null && typeof activeTabId !== 'string') return null;
  if (typeof activeTabId === 'string' && !tabIds.includes(activeTabId)) return null;
  // A non-empty pane with a null activeTabId would render nothing despite
  // having open tabs — coerce to the last tab instead of rejecting the whole
  // persisted layout (mirrors the fallback every other tree operation uses,
  // e.g. closeTab()'s newActiveTabId computation).
  const resolvedActiveTabId = activeTabId === null && tabIds.length > 0
    ? tabIds[tabIds.length - 1]
    : activeTabId;
  return { type: 'pane', id, tabIds: [...tabIds], activeTabId: resolvedActiveTabId };
}

function normalizeSplitNode(value: Record<string, unknown>): SplitNode | null {
  const { dir, ratio, a, b } = value;
  if (dir !== 'row' && dir !== 'col') return null;
  if (typeof ratio !== 'number' || Number.isNaN(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) return null;
  const normalizedA = normalizeLayout(a);
  const normalizedB = normalizeLayout(b);
  if (normalizedA === null || normalizedB === null) return null;
  return { type: 'split', dir, ratio, a: normalizedA, b: normalizedB };
}

/** Validates persisted JSON as a `LayoutNode`. Returns `null` for anything malformed. */
export function normalizeLayout(value: unknown): LayoutNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  let node: LayoutNode | null = null;
  if (record.type === 'pane') node = normalizePaneNode(record);
  else if (record.type === 'split') node = normalizeSplitNode(record);
  if (!node) return null;

  // Duplicate pane ids would make replacePane()/collapsePane() (which locate
  // a pane by id) touch more than one node at once, silently corrupting the
  // tree. Reject the whole persisted layout rather than risk that.
  const ids = listPanes(node).map((p) => p.id);
  if (new Set(ids).size !== ids.length) return null;

  // Every tab must belong to exactly one pane — findPaneByTab()/moveTab()/
  // closeTab() all assume a tab id is unique across the whole tree. A
  // duplicate (whether within one pane or split across two) would make those
  // operations silently act on the wrong pane. Reject the whole layout.
  const tabIds = listPanes(node).flatMap((p) => p.tabIds);
  if (new Set(tabIds).size !== tabIds.length) return null;

  return node;
}

/**
 * Advances the module-level pane id counter so that ids generated by
 * `createPane()` after restoring `root` from persisted storage never collide
 * with ids already present in `root`. Call this once, right after a
 * successful `normalizeLayout()`, before any further `createPane()` calls.
 */
export function reseedPaneIdCounter(root: LayoutNode): void {
  for (const p of listPanes(root)) {
    const match = /^p(\d+)$/.exec(p.id);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (n > paneIdCounter) paneIdCounter = n;
  }
}
