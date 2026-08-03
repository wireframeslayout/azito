import { describe, it, expect } from 'vitest';
import {
  createPane,
  listPanes,
  findPane,
  findPaneByTab,
  findNextPaneId,
  splitPane,
  moveTab,
  moveTabToNextPane,
  mergePaneIntoNext,
  removePane,
  closeTab,
  openTab,
  setActiveTab,
  setRatio,
  reconcile,
  normalizeLayout,
  reseedPaneIdCounter,
  type LayoutNode,
  type PaneNode,
  type SplitNode,
} from './paneLayoutTree';

describe('createPane / listPanes / findPane / findPaneByTab', () => {
  it('creates panes with unique ids', () => {
    const a = createPane(['t1']);
    const b = createPane(['t2']);
    expect(a.id).not.toBe(b.id);
    expect(a.tabIds).toEqual(['t1']);
    expect(a.activeTabId).toBe('t1');
  });

  it('lists panes depth-first, a before b', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: {
        type: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
        b: { type: 'pane', id: 'p3', tabIds: ['t3'], activeTabId: 't3' },
      },
    };
    expect(listPanes(root).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('findPane / findPaneByTab locate nested panes', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    expect(findPane(root, 'p2')?.id).toBe('p2');
    expect(findPane(root, 'missing')).toBeNull();
    expect(findPaneByTab(root, 't2')?.id).toBe('p2');
    expect(findPaneByTab(root, 'missing')).toBeNull();
  });
});

describe('splitPane', () => {
  it('places the new pane as `a` for left/top and as `b` for right/bottom', () => {
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };

    const left = splitPane(root, 'p1', 'left', 't2', null) as SplitNode;
    expect(left.dir).toBe('row');
    expect((left.a as PaneNode).tabIds).toEqual(['t2']);
    expect((left.b as PaneNode).id).toBe('p1');

    const right = splitPane(root, 'p1', 'right', 't2', null) as SplitNode;
    expect(right.dir).toBe('row');
    expect((right.b as PaneNode).tabIds).toEqual(['t2']);
    expect((right.a as PaneNode).id).toBe('p1');

    const top = splitPane(root, 'p1', 'top', 't2', null) as SplitNode;
    expect(top.dir).toBe('col');
    expect((top.a as PaneNode).tabIds).toEqual(['t2']);

    const bottom = splitPane(root, 'p1', 'bottom', 't2', null) as SplitNode;
    expect(bottom.dir).toBe('col');
    expect((bottom.b as PaneNode).tabIds).toEqual(['t2']);
  });

  it('detaches the moved tab from fromPaneId, folding it away if it becomes empty', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const result = splitPane(root, 'p1', 'right', 't2', 'p2') as SplitNode;
    // p2 had only t2; moving it away should fold p2's parent split away entirely,
    // leaving a single split created by the new splitPane call around p1.
    const panes = listPanes(result);
    expect(panes.map((p) => p.id).includes('p2')).toBe(false);
    expect(panes.some((p) => p.tabIds.includes('t2'))).toBe(true);
    expect(panes.some((p) => p.tabIds.includes('t1'))).toBe(true);
  });

  it('self-splitting a single-tab pane produces a split with the tab on the new side and an empty pane on the original side', () => {
    // Not a no-op: the empty "remaining" pane is a first-class state (reconcile()
    // preserves an originally-empty pane, SplitLayoutPane renders a placeholder for it,
    // and its trailing ✕ closes it), so a context-menu split / edge drop on a single-tab
    // pane must still produce a visible split.
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    const result = splitPane(root, 'p1', 'left', 't1', 'p1') as SplitNode;
    expect(result.type).toBe('split');
    // The original pane id keeps its place in the tree but ends up empty ...
    const emptyPane = findPane(result, 'p1') as PaneNode;
    expect(emptyPane.tabIds).toEqual([]);
    expect(emptyPane.activeTabId).toBeNull();
    // ... while a newly-created pane holds the tab that was "split off".
    const panes = listPanes(result);
    const newPane = panes.find((p) => p.id !== 'p1') as PaneNode;
    expect(newPane.tabIds).toEqual(['t1']);
    expect(newPane.activeTabId).toBe('t1');
    // zone: 'left' places the new pane first (`a`), the original (now empty) pane second.
    expect((result.a as PaneNode).id).toBe(newPane.id);
    expect((result.b as PaneNode).id).toBe('p1');
  });

  it('does not mutate the input tree', () => {
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    const before = JSON.stringify(root);
    splitPane(root, 'p1', 'right', 't2', null);
    expect(JSON.stringify(root)).toBe(before);
  });
});

describe('moveTab', () => {
  it('moves a tab between panes, inserting at a given index', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't2' },
      b: { type: 'pane', id: 'p2', tabIds: ['t3', 't4'], activeTabId: 't4' },
    };
    const result = moveTab(root, 't2', 'p1', 'p2', 0) as SplitNode;
    expect((result.a as PaneNode).tabIds).toEqual(['t1']);
    expect((result.b as PaneNode).tabIds).toEqual(['t2', 't3', 't4']);
    expect((result.b as PaneNode).activeTabId).toBe('t2');
  });

  it('appends to the end of the destination pane when index is omitted', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't2' },
      b: { type: 'pane', id: 'p2', tabIds: ['t3'], activeTabId: 't3' },
    };
    const result = moveTab(root, 't1', 'p1', 'p2') as SplitNode;
    expect((result.b as PaneNode).tabIds).toEqual(['t3', 't1']);
  });

  it('reorders within the same pane; index is the insertion position in the pre-removal array', () => {
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1', 't2', 't3'], activeTabId: 't1' };

    // Move the last item to the front (index 0, before its current position: no adjustment needed).
    const toFront = moveTab(root, 't3', 'p1', 'p1', 0) as PaneNode;
    expect(toFront.tabIds).toEqual(['t3', 't1', 't2']);

    // Move the first item past the end (index 3, one past the last slot of the
    // pre-removal array — i.e. "drop after t3"). Since 3 > t1's current index (0),
    // it is adjusted internally to 2 against the post-removal array.
    const toEnd = moveTab(root, 't1', 'p1', 'p1', 3) as PaneNode;
    expect(toEnd.tabIds).toEqual(['t2', 't3', 't1']);

    // Dropping at the tab's own current index is a no-op reorder.
    const noOp = moveTab(root, 't2', 'p1', 'p1', 1) as PaneNode;
    expect(noOp.tabIds).toEqual(['t1', 't2', 't3']);
  });

  it('reorders correctly when the drop index lands strictly behind the dragged tab', () => {
    // Regression for the "index means pre-removal insertion position" semantics:
    // dragging t1 (index 0) to index 2 (immediately before t3, i.e. behind t1's
    // original position) must land t1 between t2 and t3, not swallow a slot.
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1', 't2', 't3'], activeTabId: 't1' };
    const result = moveTab(root, 't1', 'p1', 'p1', 2) as PaneNode;
    expect(result.tabIds).toEqual(['t2', 't1', 't3']);
  });

  it('activates without reordering when index is omitted for a same-pane move', () => {
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't1' };
    const result = moveTab(root, 't2', 'p1', 'p1') as PaneNode;
    expect(result.tabIds).toEqual(['t1', 't2']);
    expect(result.activeTabId).toBe('t2');
  });

  it('folds the source pane away once it becomes empty', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const result = moveTab(root, 't1', 'p1', 'p2') as PaneNode;
    expect(result.type).toBe('pane');
    expect(result.id).toBe('p2');
    expect(result.tabIds).toEqual(['t2', 't1']);
  });
});

describe('moveTabToNextPane / mergePaneIntoNext / removePane / closeTab', () => {
  function threePaneTree(): LayoutNode {
    return {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: {
        type: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
        b: { type: 'pane', id: 'p3', tabIds: ['t3'], activeTabId: 't3' },
      },
    };
  }

  it('moveTabToNextPane moves to the next pane, wrapping from the last to the first', () => {
    const root = threePaneTree();
    const moved = moveTabToNextPane(root, 'p1', 't1');
    expect(findPane(moved, 'p2')?.tabIds).toContain('t1');

    const wrapped = moveTabToNextPane(root, 'p3', 't3');
    expect(findPane(wrapped, 'p1')?.tabIds).toContain('t3');
  });

  it('findNextPaneId resolves the wrap-around destination, and null when there is nothing to wrap to', () => {
    const root = threePaneTree();
    expect(findNextPaneId(root, 'p1')).toBe('p2');
    expect(findNextPaneId(root, 'p3')).toBe('p1'); // wraps last -> first

    expect(findNextPaneId(root, 'missing')).toBeNull();

    const single: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    expect(findNextPaneId(single, 'p1')).toBeNull();
  });

  it('mergePaneIntoNext merges tabs into the next pane and folds the source, carrying activeTabId', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't2' },
      b: { type: 'pane', id: 'p2', tabIds: ['t3'], activeTabId: 't3' },
    };
    const result = mergePaneIntoNext(root, 'p1') as PaneNode;
    expect(result.type).toBe('pane');
    expect(result.tabIds).toEqual(['t3', 't1', 't2']);
    expect(result.activeTabId).toBe('t2');
  });

  it('mergePaneIntoNext skips duplicate tabs and is a no-op with a single pane', () => {
    const dup: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t1', 't2'], activeTabId: 't2' },
    };
    const result = mergePaneIntoNext(dup, 'p1') as PaneNode;
    expect(result.tabIds).toEqual(['t1', 't2']);

    const single: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    expect(mergePaneIntoNext(single, 'p1')).toBe(single);
  });

  it('removePane folds a pane away and is a no-op on the sole remaining pane', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const result = removePane(root, 'p1') as PaneNode;
    expect(result.id).toBe('p2');

    const single: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    expect(removePane(single, 'p1')).toBe(single);
  });

  it('closeTab removes a tab, promotes a new active tab, and folds an emptied pane', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't2' },
      b: { type: 'pane', id: 'p2', tabIds: ['t3'], activeTabId: 't3' },
    };
    const closedActive = closeTab(root, 'p1', 't2') as SplitNode;
    const p1After = closedActive.a as PaneNode;
    expect(p1After.tabIds).toEqual(['t1']);
    expect(p1After.activeTabId).toBe('t1');

    const closedLast = closeTab(root, 'p2', 't3') as PaneNode;
    expect(closedLast.id).toBe('p1');
  });

  it('closeTab keeps a lone root pane empty instead of folding it away', () => {
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    const result = closeTab(root, 'p1', 't1') as PaneNode;
    expect(result.type).toBe('pane');
    expect(result.tabIds).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });
});

describe('openTab / setActiveTab / setRatio', () => {
  it('openTab activates an already-open tab in place', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t3'], activeTabId: 't3' },
    };
    const { root: result, paneId } = openTab(root, 't2', 'p2');
    expect(paneId).toBe('p1');
    expect((findPane(result, 'p1') as PaneNode).activeTabId).toBe('t2');
  });

  it('openTab adds a new tab to the preferred pane, or the first pane otherwise', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const preferred = openTab(root, 't3', 'p2');
    expect(preferred.paneId).toBe('p2');
    expect((findPane(preferred.root, 'p2') as PaneNode).tabIds).toEqual(['t2', 't3']);

    const fallback = openTab(root, 't3', 'missing');
    expect(fallback.paneId).toBe('p1');
  });

  it('setActiveTab updates activeTabId and setRatio clamps and navigates by path', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't1' },
      b: {
        type: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { type: 'pane', id: 'p2', tabIds: ['t3'], activeTabId: 't3' },
        b: { type: 'pane', id: 'p3', tabIds: ['t4'], activeTabId: 't4' },
      },
    };
    const activated = setActiveTab(root, 'p1', 't2');
    expect((findPane(activated, 'p1') as PaneNode).activeTabId).toBe('t2');

    const rootResized = setRatio(root, '', 0.3) as SplitNode;
    expect(rootResized.ratio).toBe(0.3);

    const nestedResized = setRatio(root, 'b', 0.9) as SplitNode;
    expect(((nestedResized.b as SplitNode)).ratio).toBe(0.85);

    const clampedLow = setRatio(root, '', 0.01) as SplitNode;
    expect(clampedLow.ratio).toBe(0.15);
  });
});

describe('reconcile', () => {
  it('removes tabs no longer present and folds emptied panes', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const result = reconcile(root, ['t2']) as PaneNode;
    expect(result.id).toBe('p2');
    expect(result.tabIds).toEqual(['t2']);
  });

  it('appends tabs missing from the tree to the first pane', () => {
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    const result = reconcile(root, ['t1', 't2']) as PaneNode;
    expect(result.tabIds).toEqual(['t1', 't2']);
  });

  it('appends a missing tab to preferredPaneId when given, instead of the first pane', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const result = reconcile(root, ['t1', 't2', 't3'], 'p2') as SplitNode;
    expect((result.a as PaneNode).tabIds).toEqual(['t1']);
    expect((result.b as PaneNode).tabIds).toEqual(['t2', 't3']);
    // activeTabId is left as-is when the target pane already had one — only a
    // pane with no active tab (activeTabId === null) adopts the newly-appended tab.
    expect((result.b as PaneNode).activeTabId).toBe('t2');
  });

  it('places a missing tab into an intentionally-empty preferredPaneId instead of folding it away', () => {
    // e.g. the user split off a new empty pane and focused it, then opened a
    // tab from the sidebar while it was still empty.
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: [], activeTabId: null },
    };
    const result = reconcile(root, ['t1', 't2'], 'p2') as SplitNode;
    expect(result.type).toBe('split');
    expect((result.a as PaneNode).tabIds).toEqual(['t1']);
    expect((result.b as PaneNode).id).toBe('p2');
    expect((result.b as PaneNode).tabIds).toEqual(['t2']);
    expect((result.b as PaneNode).activeTabId).toBe('t2');
  });

  it('keeps a pane that was already empty before pruning, without needing preferredPaneId protection', () => {
    // e.g. a freshly-split empty pane (◫/⬓ placeholder) must survive an allTabIds
    // reference change (windows-list poll, reload) even when it isn't preferredPaneId —
    // only a pane emptied *by* this prune pass is a fold candidate.
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: [], activeTabId: null },
    };
    const result = reconcile(root, ['t1'], null) as SplitNode;
    expect(result.type).toBe('split');
    expect((result.b as PaneNode).id).toBe('p2');
    expect((result.b as PaneNode).tabIds).toEqual([]);
  });

  it('still folds a pane that becomes empty as a result of pruning (not originally empty)', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    // t2 disappears, so p2 becomes empty as a *result* of this prune — it should still fold.
    const result = reconcile(root, ['t1'], null) as PaneNode;
    expect(result.type).toBe('pane');
    expect(result.id).toBe('p1');
  });

  it('keeps a nested originally-empty pane even after its sibling subtree prunes away entirely', () => {
    // p3 (nested two levels deep) is originally empty. Its sibling p4 holds only an
    // invalid tab, so pruning collapses the *inner* split down to p3 alone before the
    // outer split is ever examined — a shallow "is node.a itself an empty pane?" check at
    // the outer level would see a pane that "just became empty" (node.a was a split, not
    // a pane, going in) and wrongly fold it away. p3's own already-empty status must
    // survive that collapse and propagate up.
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: {
        type: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { type: 'pane', id: 'p3', tabIds: [], activeTabId: null },
        b: { type: 'pane', id: 'p4', tabIds: ['t2'], activeTabId: 't2' },
      },
      b: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
    };
    const result = reconcile(root, ['t1'], null) as SplitNode;
    expect(result.type).toBe('split');
    expect((result.a as PaneNode).id).toBe('p3');
    expect((result.a as PaneNode).tabIds).toEqual([]);
    expect((result.b as PaneNode).id).toBe('p1');
  });

  it('folds a nested pane whose entire subtree became empty purely as a result of pruning', () => {
    // Contrast with the previous test: neither p3 nor p4 was empty going in, both lose
    // their only tab to pruning, so the inner split collapses to a *pruned*-empty pane —
    // which must still be foldable once that result reaches the outer split.
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: {
        type: 'split',
        dir: 'col',
        ratio: 0.5,
        a: { type: 'pane', id: 'p3', tabIds: ['t2'], activeTabId: 't2' },
        b: { type: 'pane', id: 'p4', tabIds: ['t3'], activeTabId: 't3' },
      },
      b: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
    };
    const result = reconcile(root, ['t1'], null) as PaneNode;
    expect(result.type).toBe('pane');
    expect(result.id).toBe('p1');
  });

  it('falls back to the first pane when preferredPaneId no longer exists', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const result = reconcile(root, ['t1', 't2', 't3'], 'does-not-exist') as SplitNode;
    expect((result.a as PaneNode).tabIds).toEqual(['t1', 't3']);
    expect((result.b as PaneNode).tabIds).toEqual(['t2']);
  });

  it('collapses to a single empty pane when every tab disappears', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const result = reconcile(root, []);
    expect(result.type).toBe('pane');
    expect((result as PaneNode).tabIds).toEqual([]);
  });

  it('returns the same reference when nothing changes', () => {
    const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: 't2' };
    expect(reconcile(root, ['t1', 't2'])).toBe(root);
  });

  it('does not mutate the input tree', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    const before = JSON.stringify(root);
    reconcile(root, ['t1']);
    expect(JSON.stringify(root)).toBe(before);
  });

  describe('appendMissing = false', () => {
    it('still removes tabs no longer present and folds emptied panes', () => {
      const root: SplitNode = {
        type: 'split',
        dir: 'row',
        ratio: 0.5,
        a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
        b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
      };
      const result = reconcile(root, ['t2'], null, false) as PaneNode;
      expect(result.id).toBe('p2');
      expect(result.tabIds).toEqual(['t2']);
    });

    it('does not append a tab that is valid but missing from the tree (e.g. a user-closed tab)', () => {
      const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
      const result = reconcile(root, ['t1', 't2'], null, false) as PaneNode;
      expect(result.tabIds).toEqual(['t1']);
    });

    it('keeps an originally-empty pane even though appendMissing never places anything into it', () => {
      // An intentionally-empty pane (e.g. freshly split via ◫/⬓) must survive reconcile
      // regardless of appendMissing/preferredPaneId — only a pane that becomes empty as a
      // *result* of pruning is a fold candidate (see the "folds a pane that becomes empty
      // via pruning" test below).
      const root: SplitNode = {
        type: 'split',
        dir: 'row',
        ratio: 0.5,
        a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
        b: { type: 'pane', id: 'p2', tabIds: [], activeTabId: null },
      };
      const result = reconcile(root, ['t1', 't2'], 'p2', false) as SplitNode;
      expect(result.type).toBe('split');
      expect((result.a as PaneNode).tabIds).toEqual(['t1']);
      expect((result.b as PaneNode).id).toBe('p2');
      expect((result.b as PaneNode).tabIds).toEqual([]);
    });

    it('returns the same reference when nothing needs pruning', () => {
      const root: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
      expect(reconcile(root, ['t1', 't2'], null, false)).toBe(root);
    });
  });
});

describe('normalizeLayout', () => {
  it('accepts a well-formed tree', () => {
    const value = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    expect(normalizeLayout(value)).toEqual(value);
  });

  it('rejects non-object input', () => {
    expect(normalizeLayout(null)).toBeNull();
    expect(normalizeLayout(undefined)).toBeNull();
    expect(normalizeLayout('not an object')).toBeNull();
    expect(normalizeLayout(42)).toBeNull();
  });

  it('rejects an unknown type discriminant', () => {
    expect(normalizeLayout({ type: 'window' })).toBeNull();
  });

  it('rejects a pane with mismatched field types', () => {
    expect(normalizeLayout({ type: 'pane', id: 42, tabIds: ['t1'], activeTabId: 't1' })).toBeNull();
    expect(normalizeLayout({ type: 'pane', id: 'p1', tabIds: 't1', activeTabId: 't1' })).toBeNull();
    expect(normalizeLayout({ type: 'pane', id: 'p1', tabIds: [1, 2], activeTabId: null })).toBeNull();
  });

  it('rejects a pane with an activeTabId not present in tabIds', () => {
    expect(normalizeLayout({ type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't2' })).toBeNull();
  });

  it('accepts a pane with empty tabIds paired with a null activeTabId', () => {
    const value = { type: 'pane', id: 'p1', tabIds: [], activeTabId: null };
    expect(normalizeLayout(value)).toEqual(value);
  });

  it('rejects an empty-tabIds pane with a non-null activeTabId', () => {
    expect(normalizeLayout({ type: 'pane', id: 'p1', tabIds: [], activeTabId: 't1' })).toBeNull();
  });

  it('heals a non-empty pane with a null activeTabId to the last tab instead of rejecting it', () => {
    const value = { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], activeTabId: null };
    const result = normalizeLayout(value) as PaneNode;
    expect(result).not.toBeNull();
    expect(result.activeTabId).toBe('t2');
  });

  it('rejects a tree with duplicate pane ids', () => {
    const value = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p1', tabIds: ['t2'], activeTabId: 't2' },
    };
    expect(normalizeLayout(value)).toBeNull();
  });

  it('rejects a pane with a duplicate tab id within its own tabIds', () => {
    // Array.includes() would still find activeTabId in a self-duplicated
    // tabIds array, so this needs its own check beyond normalizePaneNode's
    // activeTabId validation.
    expect(normalizeLayout({ type: 'pane', id: 'p1', tabIds: ['t1', 't1'], activeTabId: 't1' })).toBeNull();
  });

  it('rejects a tree with the same tab id present in two different panes', () => {
    const value = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t1'], activeTabId: 't1' },
    };
    expect(normalizeLayout(value)).toBeNull();
  });

  it('rejects a split with an out-of-range ratio', () => {
    const base = {
      type: 'split',
      dir: 'row',
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' },
    };
    expect(normalizeLayout({ ...base, ratio: 0.05 })).toBeNull();
    expect(normalizeLayout({ ...base, ratio: 0.95 })).toBeNull();
    expect(normalizeLayout({ ...base, ratio: Number.NaN })).toBeNull();
  });

  it('rejects a split with an invalid dir or a malformed child', () => {
    const pane1 = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    const pane2 = { type: 'pane', id: 'p2', tabIds: ['t2'], activeTabId: 't2' };
    expect(normalizeLayout({ type: 'split', dir: 'diagonal', ratio: 0.5, a: pane1, b: pane2 })).toBeNull();
    expect(normalizeLayout({ type: 'split', dir: 'row', ratio: 0.5, a: { type: 'pane' }, b: pane2 })).toBeNull();
  });
});

describe('reseedPaneIdCounter', () => {
  it('advances the counter past the highest p<N> id found in the tree', () => {
    const root: SplitNode = {
      type: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' },
      b: { type: 'pane', id: 'p500', tabIds: ['t2'], activeTabId: 't2' },
    };
    reseedPaneIdCounter(root);
    const created = createPane(['t3']);
    const n = Number(/^p(\d+)$/.exec(created.id)?.[1]);
    expect(n).toBeGreaterThan(500);
  });

  it('prevents a restored tree from getting a colliding pane id on split', () => {
    // Simulates: load a persisted layout containing "p1", reseed as usePaneLayout
    // does, then split — without reseeding, the module counter would still be
    // low and createPane() could mint "p1" again, corrupting the tree.
    const restored: PaneNode = { type: 'pane', id: 'p1', tabIds: ['t1'], activeTabId: 't1' };
    reseedPaneIdCounter(restored);
    const result = splitPane(restored, 'p1', 'right', 't2', null) as SplitNode;
    const ids = listPanes(result).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('p1');
  });
});

// Documents the precondition usePaneLayout's `ready` option (usePaneLayout.ts) exists
// to guard: a persisted tree must never be reconciled against a caller's tab set before
// that tab set is trustworthy (e.g. TaskPanel's `allTabIds` starts windowless — `windows`
// is `[]` — until the first `/tasks/:id` fetch resolves). usePaneLayout itself can't be
// unit-tested here (it's a React hook, and this project's vitest config runs in a plain
// 'node' environment with no jsdom/@testing-library/react — no DOM or React runtime is
// available), so this exercises the same reconcile() a "not ready yet" reconcile would
// wrongly run, and the deferred reconcile a "ready" one runs once the tab set catches up.
describe('reconcile against an async, not-yet-populated tab set (regression coverage for usePaneLayout ready)', () => {
  it('would prune a persisted window tab if reconciled before the tab set is populated', () => {
    const persisted: PaneNode = {
      type: 'pane', id: 'p1',
      tabIds: ['view:description', 'v-window:local/sess:1.0'],
      activeTabId: 'v-window:local/sess:1.0',
    };
    // Simulates the exact bug: allTabIds computed while `windows === []` (before the
    // first fetch resolves) only carries fixed views, not yet the persisted window tab.
    const prematureAllTabIds = ['view:description'];
    const reconciledTooSoon = reconcile(persisted, prematureAllTabIds, null, false) as PaneNode;
    expect(reconciledTooSoon.tabIds).toEqual(['view:description']);
  });

  it('preserves the persisted window tab once reconciled against the caught-up tab set', () => {
    const persisted: PaneNode = {
      type: 'pane', id: 'p1',
      tabIds: ['view:description', 'v-window:local/sess:1.0'],
      activeTabId: 'v-window:local/sess:1.0',
    };
    const settledAllTabIds = ['view:description', 'v-window:local/sess:1.0'];
    const result = reconcile(persisted, settledAllTabIds, null, false) as PaneNode;
    expect(result).toBe(persisted); // same reference: reconcile() is a no-op here
    expect(result.tabIds).toEqual(['view:description', 'v-window:local/sess:1.0']);
  });

  it('leaves the tree completely untouched when reconcile is simply not called (the "not ready" state)', () => {
    // usePaneLayout's loadInitialState() no longer calls reconcile() at all — this is
    // what "not ready" actually looks like: the raw persisted tree, unmodified.
    const persisted: PaneNode = {
      type: 'pane', id: 'p1',
      tabIds: ['view:description', 'v-window:local/sess:1.0'],
      activeTabId: 'v-window:local/sess:1.0',
    };
    expect(persisted.tabIds).toEqual(['view:description', 'v-window:local/sess:1.0']);
  });
});
