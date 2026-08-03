import { useState, useCallback, useRef, useEffect } from 'react';
import {
  createPane,
  findPane,
  findNextPaneId,
  listPanes,
  reconcile,
  normalizeLayout,
  reseedPaneIdCounter,
  splitPane,
  moveTab,
  moveTabToNextPane,
  mergePaneIntoNext,
  closeTab,
  openTab,
  setActiveTab,
  setRatio,
  type LayoutNode,
  type DropZone,
} from './paneLayoutTree';

export interface PaneLayoutState {
  root: LayoutNode;
  focusedPaneId: string | null;
}

// Tags the in-memory state with the storageKey it was loaded for, so a
// storageKey change and its corresponding state reload always commit
// together (see usePaneLayout below) — the persist effect can then never
// observe a state that belongs to a different key than the one it writes to.
interface KeyedPaneLayoutState {
  key: string;
  state: PaneLayoutState;
}

interface PersistedPaneLayout {
  root: unknown;
  focusedPaneId: unknown;
}

/**
 * Storage adapter usePaneLayout delegates persistence to. `load()` returns the
 * raw persisted value (or null/undefined when there is none) shaped like
 * `{ root, focusedPaneId }`; `save()` receives that same shape. Callers that
 * need a different on-disk representation (e.g. TaskPanel's per-task map,
 * keyed under a `layout` field) translate to/from this shape inside their own
 * adapter — usePaneLayout itself always speaks `{ root, focusedPaneId }`.
 */
export interface PaneLayoutStorage {
  load(): unknown;
  save(value: unknown): void;
}

function defaultStorage(storageKey: string): PaneLayoutStorage {
  return {
    load: () => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save: (value: unknown) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(value));
      } catch {
        // localStorage unavailable (private mode / quota exceeded): persistence is best-effort.
      }
    },
  };
}

/**
 * Loads (or seeds) the raw persisted tree — deliberately *not* reconciled
 * against `allTabIds` here. Reconciling at load time against whatever
 * `allTabIds` happens to be on the very first render is unsafe for callers
 * whose tab set is only known asynchronously (e.g. TaskPanel: `windows` is
 * `[]` until the first `/tasks/:id` fetch resolves) — it would prune every
 * persisted window tab before that fetch ever completes. Reconciliation is
 * instead the sole responsibility of the `allTabIds`-sync effect below,
 * gated by `ready` so it doesn't run before the caller's tab set is trustworthy.
 * `initialTabIds` is used only for the "nothing persisted yet" fallback,
 * where it seeds the one-and-only pane's initial tab set.
 */
function loadInitialState(storage: PaneLayoutStorage, initialTabIds: string[]): PaneLayoutState {
  try {
    const parsed = storage.load() as PersistedPaneLayout | null | undefined;
    if (parsed) {
      const root = normalizeLayout(parsed.root);
      if (root) {
        // Restored pane ids must not be re-minted by later createPane() calls
        // (split/openTab), or replacePane() would update two panes at once.
        reseedPaneIdCounter(root);
        const focusedPaneId = typeof parsed.focusedPaneId === 'string' && findPane(root, parsed.focusedPaneId)
          ? parsed.focusedPaneId
          : listPanes(root)[0].id;
        return { root, focusedPaneId };
      }
    }
  } catch {
    // Malformed/unreadable persisted layout: fall through to a fresh single pane.
  }
  const pane = createPane(initialTabIds, initialTabIds.length > 0 ? initialTabIds[initialTabIds.length - 1] : null);
  return { root: pane, focusedPaneId: pane.id };
}

function persist(storage: PaneLayoutStorage, state: PaneLayoutState): void {
  storage.save({ root: state.root, focusedPaneId: state.focusedPaneId });
}

export interface UsePaneLayoutOptions {
  /**
   * Whether tab ids present in `allTabIds` but missing from the tree get
   * auto-appended (default true, matching Workspace's "allTabIds = tabs the
   * user currently has open" model). Set to false for a scope where
   * `allTabIds` instead means "tabs available to open" — e.g. TaskPanel's
   * fixed views + assigned windows — so a tab the user explicitly closed via
   * × stays closed instead of reappearing the next time `allTabIds` changes
   * reference (e.g. a windows-list poll).
   */
  appendMissing?: boolean;
  /**
   * Whether the `allTabIds`-sync effect is allowed to reconcile yet (default
   * true). Set to false while the caller's tab set isn't trustworthy — e.g.
   * TaskPanel before its first windows fetch resolves, where `allTabIds`
   * starts as just the fixed views and would otherwise prune every
   * persisted window tab before the fetch had a chance to complete. The
   * tree is left exactly as loaded (no reconcile at all) until `ready`
   * flips to true, at which point the first reconcile runs against
   * whatever `allTabIds` is by then.
   */
  ready?: boolean;
}

/**
 * Owns the pane-split layout tree for a Workspace-like multi-pane view.
 * Persists to `localStorage[storageKey]` (or a custom `storage` adapter) and
 * keeps the tree reconciled against the live set of tab ids (`allTabIds`) as
 * it changes.
 */
export function usePaneLayout(
  storageKey: string,
  allTabIds: string[],
  initialTabIds?: string[],
  storage?: PaneLayoutStorage,
  options?: UsePaneLayoutOptions,
) {
  // Read fresh every render (cheap: just an object literal unless a custom
  // adapter is passed) so the reload-on-key-change branch and the persist
  // effect below always see the caller's latest adapter, without forcing
  // callers to memoize it themselves.
  const resolvedStorage = storage ?? defaultStorage(storageKey);
  const storageRef = useRef(resolvedStorage);
  storageRef.current = resolvedStorage;
  const appendMissing = options?.appendMissing ?? true;
  const ready = options?.ready ?? true;

  const initialized = useRef(false);
  const [keyed, setKeyed] = useState<KeyedPaneLayoutState>(() => ({
    key: storageKey,
    state: loadInitialState(resolvedStorage, initialTabIds ?? allTabIds),
  }));

  // If storageKey changes without an unmount, reload from the new key instead
  // of keeping the old key's state around. This runs during render ("adjusting
  // state during render", an officially supported React pattern): React
  // discards the in-progress render and re-renders immediately with the new
  // state, so the persist effect below never fires for the stale key/state
  // pairing (key and state always change atomically in the same commit).
  if (keyed.key !== storageKey) {
    setKeyed({ key: storageKey, state: loadInitialState(resolvedStorage, initialTabIds ?? allTabIds) });
  }

  const state = keyed.state;

  const setState = useCallback((updater: (prev: PaneLayoutState) => PaneLayoutState) => {
    setKeyed((prev) => {
      const nextState = updater(prev.state);
      return nextState === prev.state ? prev : { key: prev.key, state: nextState };
    });
  }, []);

  useEffect(() => {
    initialized.current = true;
  }, []);

  useEffect(() => {
    if (!initialized.current) return;
    persist(storageRef.current, keyed.state);
  }, [keyed]);

  // Keep the tree in sync with the live tab set. reconcile() returns the same
  // `root` reference when nothing needs to change, so this settles after one
  // pass instead of looping. This is the *only* place reconcile() runs (see
  // loadInitialState's doc comment) — skipped entirely while `ready` is
  // false, so a caller with an async tab set never has its persisted layout
  // pruned against a still-empty `allTabIds`. Once `ready` flips true, this
  // effect re-fires and reconciles against `allTabIds` as of that render.
  useEffect(() => {
    if (!ready) return;
    setState((prev) => {
      const reconciled = reconcile(prev.root, allTabIds, prev.focusedPaneId, appendMissing);
      if (reconciled === prev.root) return prev;
      const focusedPaneId = prev.focusedPaneId && findPane(reconciled, prev.focusedPaneId)
        ? prev.focusedPaneId
        : listPanes(reconciled)[0].id;
      return { root: reconciled, focusedPaneId };
    });
    // allTabIds is expected to be a fresh array each render; reconcile() is a
    // no-op (same reference) when the tab set hasn't actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTabIds, appendMissing, ready, setState]);

  const split = useCallback((targetPaneId: string, zone: Extract<DropZone, 'left' | 'right' | 'top' | 'bottom'>, tabId: string | null, fromPaneId: string | null) => {
    setState((prev) => {
      const root = splitPane(prev.root, targetPaneId, zone, tabId, fromPaneId);
      if (root === prev.root) return prev;
      const prevPaneIds = new Set(listPanes(prev.root).map((p) => p.id));
      const created = listPanes(root).find((p) => !prevPaneIds.has(p.id));
      return { root, focusedPaneId: created ? created.id : targetPaneId };
    });
  }, [setState]);

  const move = useCallback((tabId: string, fromPaneId: string, toPaneId: string, index?: number) => {
    setState((prev) => ({ root: moveTab(prev.root, tabId, fromPaneId, toPaneId, index), focusedPaneId: toPaneId }));
  }, [setState]);

  const moveToNext = useCallback((paneId: string, tabId: string) => {
    setState((prev) => {
      // Determine the destination (the "next" pane, wrapping around) before
      // the tree transform — afterwards fromPaneId may have folded away,
      // changing listPanes() order and breaking a post-hoc lookup.
      const nextPaneId = findNextPaneId(prev.root, paneId);
      const root = moveTabToNextPane(prev.root, paneId, tabId);
      const focusedPaneId = nextPaneId && findPane(root, nextPaneId)
        ? nextPaneId
        : listPanes(root)[0].id;
      return { root, focusedPaneId };
    });
  }, [setState]);

  const merge = useCallback((paneId: string) => {
    setState((prev) => {
      // Same rationale as moveToNext(): compute the destination pane id
      // before the merge folds the source pane away.
      const nextPaneId = findNextPaneId(prev.root, paneId);
      const root = mergePaneIntoNext(prev.root, paneId);
      const focusedPaneId = nextPaneId && findPane(root, nextPaneId)
        ? nextPaneId
        : listPanes(root)[0].id;
      return { root, focusedPaneId };
    });
  }, [setState]);

  const close = useCallback((paneId: string, tabId: string) => {
    setState((prev) => {
      const root = closeTab(prev.root, paneId, tabId);
      const focusedPaneId = prev.focusedPaneId && findPane(root, prev.focusedPaneId)
        ? prev.focusedPaneId
        : listPanes(root)[0].id;
      return { root, focusedPaneId };
    });
  }, [setState]);

  const open = useCallback((tabId: string, preferredPaneId?: string | null) => {
    setState((prev) => {
      const { root, paneId } = openTab(prev.root, tabId, preferredPaneId ?? prev.focusedPaneId);
      return { root, focusedPaneId: paneId };
    });
  }, [setState]);

  const focusPane = useCallback((paneId: string) => {
    setState((prev) => (prev.focusedPaneId === paneId ? prev : { ...prev, focusedPaneId: paneId }));
  }, [setState]);

  const setActive = useCallback((paneId: string, tabId: string) => {
    setState((prev) => ({ ...prev, root: setActiveTab(prev.root, paneId, tabId) }));
  }, [setState]);

  const resize = useCallback((splitPath: string, ratio: number) => {
    setState((prev) => ({ ...prev, root: setRatio(prev.root, splitPath, ratio) }));
  }, [setState]);

  return { state, split, move, moveToNext, merge, close, open, focusPane, setActive, resize };
}
