import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { closeBrowserGroup } from '../lib/browserGroup';

export type TabType = 'terminal' | 'file' | 'unit' | 'task' | 'task-form' | 'unit-form' | 'sidekick-form' | 'issue' | 'issue-list' | 'server' | 'settings' | 'project-tasks' | 'storage-file' | 'diff' | 'browser';

const FORM_TAB_TYPES: readonly TabType[] = ['task-form', 'unit-form', 'sidekick-form'];

export interface PersistedTab {
  id: string;
  type: TabType;
  label: string;
  pinned?: boolean;
  projectId?: number;
  // The tab that was active when this tab was opened ("opener"). Used to restore
  // a sensible "back" destination (EyebrowBack, closeTab fallback) instead of
  // always landing on null / an adjacent tab. Defaults to the caller's
  // activeTabId at open time (see openTab) so existing call sites don't need
  // to pass it explicitly.
  openerTabId?: string;
  // Terminal-specific
  serverName?: string;
  target?: string;
  // File-specific
  filePath?: string;
  line?: number;
  // Unit/Task-specific
  entityId?: number;
  // Task navigation origin
  from?: 'global' | 'workspace';
  // Issue-specific
  issueData?: { repoId: number; owner: string; repo: string; number: number };
  // Settings-specific
  settingsSection?: string;
  // Task form-specific
  taskFormData?: {
    mode: 'create' | 'edit';
    taskId?: number;
    projectId?: number;
    presetTitle?: string;
    presetDescription?: string;
    presetSource?: { source: string; sourceRef: string };
  };
  // Storage file preview-specific
  storageFileData?: { projectId: number; filename: string; originalName: string; size: number };
  // Diff viewer-specific
  diffData?: { serverName: string; path: string; baseBranch?: string };
  // Issue list-specific
  issueListData?: { repoId: number; owner: string; repo: string; provider?: string };
  // Unit form-specific
  unitFormData?: { mode: 'create' | 'edit'; unitId?: number };
  // Project form-specific
  projectFormData?: { mode: 'create' };
  // Sidekick form-specific
  sidekickFormData?: { mode: 'create' | 'edit'; sidekickName?: string };
  // Browser-specific
  browserData?: { serverName: string; pageId: string; lastActiveTabId?: string };
  reconnectKey?: number;
  // Editor dirty state. In-memory only — stripped before writing to
  // localStorage (serialize effect below) and stripped again on hydration
  // (stripDirty via normalizeLegacyTabs) so a stale flag from an older
  // client build can't resurface as a false "unsaved changes" warning.
  dirty?: boolean;
}

const STORAGE_KEY = 'workspace-tabs';
const ACTIVE_KEY = 'workspace-tabs-active';

/**
 * Migrate old per-project tab data into the new global store.
 * Scans localStorage for keys matching `workspace-tabs-<number>`,
 * merges them (dedup by id), and removes old keys.
 */
function migratePerProjectTabs(): { tabs: PersistedTab[]; activeTabId: string | null } {
  const allTabs: PersistedTab[] = [];
  let activeTabId: string | null = null;
  const keysToRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    // Match old per-project keys like "workspace-tabs-3" but not "workspace-tabs" or "workspace-tabs-active"
    const match = key.match(/^workspace-tabs-(\d+)$/);
    if (match) {
      const projectId = parseInt(match[1], 10);
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const tabs = JSON.parse(raw) as PersistedTab[];
          for (const tab of tabs) {
            tab.projectId = tab.projectId || projectId;
            allTabs.push(tab);
          }
        }
      } catch { /* ignore malformed data */ }
      keysToRemove.push(key);

      // Also check for active tab key
      const activeKey = `${key}-active`;
      const active = localStorage.getItem(activeKey);
      if (active && !activeTabId) activeTabId = active;
      keysToRemove.push(activeKey);
    }
  }

  // Dedup by tab id (keep last occurrence)
  const seen = new Map<string, PersistedTab>();
  for (const tab of allTabs) {
    seen.set(tab.id, tab);
  }
  const merged = Array.from(seen.values());

  // Save to new global store
  if (merged.length > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    if (activeTabId) localStorage.setItem(ACTIVE_KEY, activeTabId);
  }

  // Clean up old keys
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }

  return { tabs: merged, activeTabId };
}

/**
 * Normalize a persisted tab id from a previous schema version (Issue #263
 * Refine B: WorkerProfile+Operation merged into Unit) to its current form.
 * Applied both to persisted tabs (normalizeLegacyTabs) and to the persisted
 * active-tab id, so the active pointer keeps following its renamed tab.
 * - 'operation:<id>' (detail tab) -> 'unit:<id>'
 * - 'page:operations' (definitions list) -> 'page:units'
 */
function normalizeLegacyTabId(id: string): string {
  if (id === 'page:operations') return 'page:units';
  const detailMatch = id.match(/^operation:(\d+)$/);
  if (detailMatch) return `unit:${detailMatch[1]}`;
  return id;
}

/**
 * Strips the `dirty` flag from a hydrated tab. `dirty` is meant to be pure
 * in-memory editor state (see its field comment), but earlier code persisted
 * it verbatim (serializeTabsForStorage below now strips it going forward) —
 * so localStorage entries written before that fix can still carry a stale
 * `dirty: true` from whatever the editor's unsaved state happened to be at
 * last write. Applied on every hydration path so a reload never resurrects a
 * false "unsaved changes" warning for a tab whose actual editor was never
 * reopened dirty this session.
 */
export function stripDirty(tab: PersistedTab): PersistedTab {
  if (!('dirty' in tab)) return tab;
  const { dirty: _dirty, ...rest } = tab;
  return rest;
}

/**
 * Normalize tabs persisted under a previous schema version.
 * Drops removed global page tabs and legacy types, dedupes by id.
 */
export function normalizeLegacyTabs(tabs: PersistedTab[]): PersistedTab[] {
  const next: PersistedTab[] = [];
  const seenIds = new Set<string>();
  for (const rawTab of tabs) {
    const tab = stripDirty(rawTab);
    const rawType = tab.type as string;
    if (rawType === 'worker-profiles-list' || rawType === 'tasks-list' || rawType === 'operations-running') continue;
    if (rawType === 'projects-list' || rawType === 'units-list' || rawType === 'sidekicks-list' || rawType === 'global-settings' || rawType === 'project-form') continue;

    let normalized: PersistedTab;
    if (rawType === 'operation') {
      normalized = { ...tab, type: 'unit', id: normalizeLegacyTabId(tab.id) };
    } else if (rawType === 'operations-list') {
      continue;
    } else if (rawType === 'browser' && tab.browserData && !tab.browserData.pageId) {
      // Pre-multi-tab browser tabs persisted only {serverName}; treat as the
      // 'default' page so old sessions keep resolving to the same tab/page.
      normalized = { ...tab, browserData: { ...tab.browserData, pageId: 'default' } };
    } else {
      normalized = tab;
    }

    if (seenIds.has(normalized.id)) continue;
    seenIds.add(normalized.id);
    next.push(normalized);
  }
  return next;
}

export function useTabPersistence(storageKey?: string) {
  const initialized = useRef(false);

  // When storageKey is provided, use it directly (legacy mode, e.g. Terminals page).
  // When omitted, use the global cross-project store with migration.
  const effectiveKey = storageKey || STORAGE_KEY;
  const activeKey = storageKey ? `${storageKey}-active` : ACTIVE_KEY;
  const isGlobal = !storageKey;

  const [tabs, setTabs] = useState<PersistedTab[]>(() => {
    try {
      const raw = localStorage.getItem(effectiveKey);
      if (raw) return normalizeLegacyTabs(JSON.parse(raw) as PersistedTab[]);
    } catch {}
    // Try migrating old per-project data (only for global mode)
    if (isGlobal) {
      const migrated = migratePerProjectTabs();
      return normalizeLegacyTabs(migrated.tabs);
    }
    return [];
  });

  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    const stored = localStorage.getItem(activeKey);
    if (stored) return normalizeLegacyTabId(stored);
    // Check migration result (only for global mode)
    if (isGlobal) {
      const raw = localStorage.getItem(effectiveKey);
      if (!raw) {
        const migrated = migratePerProjectTabs();
        return migrated.activeTabId !== null ? normalizeLegacyTabId(migrated.activeTabId) : null;
      }
    }
    return null;
  });

  useEffect(() => { initialized.current = true; }, []);

  // Synced on every render (not in an effect) so callbacks with an empty dep
  // array can still read the latest tabs/activeTabId without becoming stale.
  const tabsRef = useRef<PersistedTab[]>(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef<string | null>(activeTabId);
  activeTabIdRef.current = activeTabId;

  useEffect(() => {
    if (!initialized.current) return;
    const persistable = tabs
      .filter((t) => !(FORM_TAB_TYPES as readonly string[]).includes(t.type))
      .map(stripDirty);
    localStorage.setItem(effectiveKey, JSON.stringify(persistable));
  }, [tabs, effectiveKey]);

  useEffect(() => {
    if (!initialized.current) return;
    localStorage.setItem(activeKey, activeTabId || '');
  }, [activeTabId, activeKey]);

  const openTab = useCallback((tab: PersistedTab) => {
    // Opener defaults to whichever tab was active when this open call was made,
    // so callers don't need to pass it explicitly for the "back" navigation to work.
    const openerTabId = tab.openerTabId ?? activeTabIdRef.current ?? undefined;
    setTabs((prev) => {
      const existing = prev.find((t) => t.id === tab.id);
      if (existing) {
        const fromChanged = tab.from !== undefined && existing.from !== tab.from;
        const settingsSectionChanged = tab.settingsSection !== undefined && existing.settingsSection !== tab.settingsSection;
        const projectIdChanged = tab.projectId !== undefined && existing.projectId !== tab.projectId;
        const lineChanged = tab.line !== undefined && existing.line !== tab.line;
        if (fromChanged || settingsSectionChanged || projectIdChanged || lineChanged) {
          return prev.map((t) => t.id === tab.id
            ? {
              ...t,
              ...(fromChanged ? { from: tab.from } : {}),
              ...(settingsSectionChanged ? { settingsSection: tab.settingsSection } : {}),
              ...(projectIdChanged ? { projectId: tab.projectId } : {}),
              ...(lineChanged ? { line: tab.line } : {}),
            }
            : t);
        }
        return prev;
      }
      const pinned = prev.filter((t) => t.pinned);
      return [...pinned, { ...tab, ...(openerTabId ? { openerTabId } : {}) }];
    });
    setActiveTabId(tab.id);
  }, []);

  const togglePin = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, pinned: !t.pinned } : t,
    ));
  }, []);

  const connectPane = useCallback((serverName: string, target: string, projectId?: number, opts?: { reconnect?: boolean }) => {
    const tabId = `terminal:${serverName}/${target}`;
    if (opts?.reconnect) {
      const existing = tabsRef.current.find((t) => t.id === tabId);
      if (existing) {
        setTabs((prev) => prev.map((t) =>
          t.id === tabId ? { ...t, reconnectKey: (t.reconnectKey ?? 0) + 1 } : t,
        ));
        setActiveTabId(tabId);
        return;
      }
    }
    openTab({
      id: tabId,
      type: 'terminal',
      label: target,
      serverName,
      target,
      projectId,
    });
  }, [openTab]);

  const openFile = useCallback((serverName: string, filePath: string, projectId?: number, line?: number) => {
    const tabId = `file:${serverName}:${filePath}`;
    const fileName = filePath.split('/').pop() || filePath;
    openTab({ id: tabId, type: 'file', label: fileName, serverName, filePath, projectId, line });
  }, [openTab]);

  const openUnit = useCallback((unitId: number, name: string, projectId?: number, openerTabId?: string) => {
    const tabId = `unit:${unitId}`;
    openTab({ id: tabId, type: 'unit', label: name, entityId: unitId, projectId, openerTabId });
  }, [openTab]);

  const openTask = useCallback((taskId: number, title: string, projectId?: number, from?: 'global' | 'workspace', openerTabId?: string) => {
    const tabId = `task:${taskId}`;
    openTab({ id: tabId, type: 'task', label: title, entityId: taskId, projectId, from, openerTabId });
  }, [openTab]);

  const openIssue = useCallback((repoId: number, owner: string, repo: string, issueNumber: number, title: string, projectId?: number) => {
    const tabId = `issue:${owner}/${repo}#${issueNumber}`;
    openTab({ id: tabId, type: 'issue', label: `#${issueNumber} ${title}`, issueData: { repoId, owner, repo, number: issueNumber }, projectId });
  }, [openTab]);

  const closeTab = useCallback((tabId: string): Promise<void> => {
    console.log('[useTabPersistence] closeTab called:', tabId);
    // Snapshot before setTabs mutates state, so the activeTabId fallback logic
    // below can inspect the closed tab's opener and its position among siblings.
    const prevTabs = tabsRef.current;
    const closedIndex = prevTabs.findIndex((t) => t.id === tabId);
    const closedTab = closedIndex !== -1 ? prevTabs[closedIndex] : undefined;

    // The tab itself closes synchronously below regardless of this promise —
    // only callers that need to know the server-side group teardown has
    // settled (e.g. before refreshing the browser-groups sidebar) should
    // await the returned promise.
    const browserGroupClosed = closedTab?.type === 'browser' && closedTab.browserData
      ? closeBrowserGroup(closedTab.browserData.serverName, closedTab.browserData.pageId)
      : Promise.resolve();

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      console.log('[useTabPersistence] tabs before:', prev.length, '→ after:', next.length);
      return next;
    });
    setActiveTabId((prev) => {
      if (prev !== tabId) return prev;
      const remaining = prevTabs.filter((t) => t.id !== tabId);
      // 1. Opener tab, if it still exists.
      if (closedTab?.openerTabId) {
        const opener = remaining.find((t) => t.id === closedTab.openerTabId);
        if (opener) return opener.id;
      }
      // 2. (No separate "previously active tab" history is tracked today, so
      //    this priority falls through to the adjacent-tab fallback below.)
      // 3. Adjacent tab (same index, or the new last tab if we closed the end).
      if (remaining.length === 0 || closedIndex === -1) return null;
      const adjacentIndex = Math.min(closedIndex, remaining.length - 1);
      return remaining[adjacentIndex].id;
    });

    return browserGroupClosed;
  }, []);

  /**
   * Activates the given tab's opener, if it still exists. Returns whether it
   * did — callers (e.g. a form's post-save navigation) typically fall back to
   * just closing the tab when this returns false.
   */
  const activateOpener = useCallback((tabId: string): boolean => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab?.openerTabId) return false;
    const openerExists = tabsRef.current.some((t) => t.id === tab.openerTabId);
    if (!openerExists) return false;
    setActiveTabId(tab.openerTabId);
    return true;
  }, []);

  /** Looks up a tab's display label (e.g. for an EyebrowBack pointing at it). */
  const getTabDisplayName = useCallback((tabId: string): string | null => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    return tab ? tab.label : null;
  }, []);

  const retargetTab = useCallback((oldTabId: string, serverName: string, newTarget: string) => {
    const newTabId = `terminal:${serverName}/${newTarget}`;
    setTabs((prev) => prev.map((t) =>
      t.id === oldTabId ? { ...t, id: newTabId, target: newTarget, label: newTarget } : t,
    ));
    setActiveTabId((prev) => prev === oldTabId ? newTabId : prev);
  }, []);

  const openServer = useCallback((serverName: string) => {
    const tabId = `server:${serverName}`;
    openTab({ id: tabId, type: 'server', label: serverName, serverName });
  }, [openTab]);

  const openSettings = useCallback((projectId: number, projectName: string, section?: string) => {
    const tabId = `settings:${projectId}`;
    openTab({ id: tabId, type: 'settings', label: `${projectName} Settings`, projectId, settingsSection: section });
  }, [openTab]);

  const reorderTab = useCallback((fromIndex: number, toIndex: number) => {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const openProjectTasks = useCallback((projectId: number, projectName: string) => {
    const tabId = `project-tasks:${projectId}`;
    openTab({ id: tabId, type: 'project-tasks', label: `${projectName} Tasks`, projectId });
  }, [openTab]);

  const openTaskForm = useCallback((opts: {
    mode: 'create' | 'edit';
    taskId?: number;
    projectId?: number;
    presetTitle?: string;
    presetDescription?: string;
    presetSource?: { source: string; sourceRef: string };
  }, openerTabId?: string) => {
    const tabId = opts.mode === 'edit' && opts.taskId
      ? `task-form:edit:${opts.taskId}`
      : `task-form:new:${opts.projectId ?? 'global'}`;
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    openTab({
      id: tabId,
      type: 'task-form',
      label: opts.mode === 'edit' ? 'Edit Task' : 'New Task',
      projectId: opts.projectId,
      taskFormData: opts,
      openerTabId,
    });
  }, [openTab]);

  const openUnitForm = useCallback((opts: { mode: 'create' | 'edit'; unitId?: number }, openerTabId?: string) => {
    const tabId = opts.mode === 'edit' && opts.unitId
      ? `unit-form:edit:${opts.unitId}`
      : 'unit-form:new';
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    openTab({
      id: tabId,
      type: 'unit-form',
      label: opts.mode === 'edit' ? 'Edit Unit' : 'New Unit',
      unitFormData: opts,
      openerTabId,
    });
  }, [openTab]);

  const openSidekickForm = useCallback((opts: { mode: 'create' | 'edit'; sidekickName?: string }, openerTabId?: string) => {
    const tabId = opts.mode === 'edit' && opts.sidekickName
      ? `sidekick-form:edit:${opts.sidekickName}`
      : 'sidekick-form:new';
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    openTab({
      id: tabId,
      type: 'sidekick-form',
      label: opts.mode === 'edit' ? `Edit: ${opts.sidekickName}` : 'New Sidekick',
      sidekickFormData: opts,
      openerTabId,
    });
  }, [openTab]);

  const openStorageFile = useCallback((projectId: number, filename: string, originalName: string, size: number) => {
    const tabId = `storage-file:${projectId}:${filename}`;
    openTab({ id: tabId, type: 'storage-file', label: originalName, projectId, storageFileData: { projectId, filename, originalName, size } });
  }, [openTab]);

  const openDiff = useCallback((serverName: string, path: string, baseBranch?: string, projectId?: number) => {
    const tabId = `diff:${serverName}:${path}:${baseBranch || 'HEAD'}`;
    openTab({ id: tabId, type: 'diff', label: `Diff: ${baseBranch || 'HEAD'}`, serverName, diffData: { serverName, path, baseBranch }, projectId });
  }, [openTab]);

  const openIssueList = useCallback((repoId: number, owner: string, repo: string, projectId?: number, provider?: string) => {
    const tabId = `issue-list:${owner}/${repo}`;
    openTab({ id: tabId, type: 'issue-list', label: `${owner}/${repo}`, projectId, issueListData: { repoId, owner, repo, provider } });
  }, [openTab]);

  const openBrowser = useCallback((serverName: string, existingGroupId?: string) => {
    if (existingGroupId) {
      const existingTabId = `browser:${serverName}/${existingGroupId}`;
      if (tabsRef.current.some((t) => t.id === existingTabId)) {
        setActiveTabId(existingTabId);
        return;
      }
      openTab({ id: existingTabId, type: 'browser', label: `Browser (${serverName})`, browserData: { serverName, pageId: existingGroupId } });
      return;
    }
    const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tabId = `browser:${serverName}/${pageId}`;
    openTab({ id: tabId, type: 'browser', label: `Browser (${serverName})`, browserData: { serverName, pageId } });
  }, [openTab, setActiveTabId]);

  /**
   * Records which Chromium tab (within a browser workspace tab's group) was
   * last active, so a reload/reconnect can restore the viewer to it instead
   * of always defaulting to 't1'.
   */
  const updateBrowserActiveTab = useCallback((tabId: string, chromiumTabId: string) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === tabId);
      // No-op (return the same array reference) when there's nothing to
      // change: prev.map() below always allocates a new array even if every
      // mapped element is referentially unchanged, and a new `tabs` array
      // identity on every call is exactly what BrowserView's effect (via
      // onActiveTabChange) uses to decide whether to re-run — an
      // unconditional new reference here would re-trigger it every time,
      // looping keepalive/reconnect churn.
      if (!target?.browserData || target.browserData.lastActiveTabId === chromiumTabId) return prev;
      return prev.map((t) =>
        t.id === tabId && t.browserData
          ? { ...t, browserData: { ...t.browserData, lastActiveTabId: chromiumTabId } }
          : t,
      );
    });
  }, []);

  const setTabDirty = useCallback((tabId: string, dirty: boolean) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === tabId);
      if (!target || target.dirty === dirty) return prev;
      return prev.map((t) => t.id === tabId ? { ...t, dirty } : t);
    });
  }, []);

  return { tabs, activeTabId, setActiveTabId, openTab, connectPane, openFile, openUnit, openTask, openTaskForm, openUnitForm, openSidekickForm, openIssue, openIssueList, openServer, openSettings, openStorageFile, openDiff, openBrowser, updateBrowserActiveTab, closeTab, retargetTab, reorderTab, openProjectTasks, togglePin, activateOpener, getTabDisplayName, setTabDirty };
}
