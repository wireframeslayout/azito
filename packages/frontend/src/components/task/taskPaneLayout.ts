/**
 * Task-scoped multi-pane tab model for TaskPanel (Issue #397 step 5) — pure
 * logic (tab id encoding, persisted-entry migration, storage adapter) kept
 * separate from TaskPanel's rendering so it stays unit-testable on its own.
 *
 * Tab ids:
 *  - fixed views: 'view:description' | 'view:unit' | 'view:git' | 'view:summary' | 'view:commits' | 'view:diff'
 *  - windows:     'v-window:<serverName>/<tmuxTarget>' — one tab per assigned tmux window.
 *
 * Persistence: entries live in the shared `SUB_TAB_KEY` localStorage map,
 * keyed by taskId, as `{ layout: LayoutNode, focusedPaneId?: string }`.
 * `normalizePersistedTaskLayout` also migrates the pre-#397 `{ view,
 * terminal? }` / bare-string shape into a minimal single-pane tree.
 *
 * Unlike Workspace's `workspace-layout` (where `allTabIds` means "tabs the
 * user currently has open"), TaskPanel's `allTabIds` means "tabs available
 * to open" — so `usePaneLayout` is used with `{ appendMissing: false }` here:
 * a fixed view or window tab the user closed via × must stay closed, not
 * reappear the next time `allTabIds` changes reference (e.g. the windows-list
 * poll). `buildDefaultTaskLayout` below is what a brand-new task (nothing
 * ever persisted) actually starts from.
 */
import type { PaneLayoutStorage } from '../../hooks/usePaneLayout';
import { findPane, listPanes, openTab, createPane, normalizeLayout, type LayoutNode } from '../../hooks/paneLayoutTree';
import type { Window, Session } from '../../pages/workspace/types';
import { isSameWindowTarget, stripPaneSuffix } from '../../utils/tmuxTarget';

// Legacy (pre-Issue #397) sub-tab model: one selected view + optional terminal ref.
// Kept only to normalize old persisted entries into the new pane-tree shape below.
const LEGACY_MAIN_VIEWS = ['description', 'window', 'unit', 'git', 'summary', 'commits', 'diff'] as const;
type LegacyMainView = (typeof LEGACY_MAIN_VIEWS)[number];

function isLegacyMainView(value: unknown): value is LegacyMainView {
  return typeof value === 'string' && (LEGACY_MAIN_VIEWS as readonly string[]).includes(value);
}

export const SUB_TAB_KEY = 'workspace-subtab-task';
const SUB_TAB_MAX_ENTRIES = 50;

export interface TerminalRef {
  serverName: string;
  target: string;
}

interface LegacySubTabEntry {
  view: LegacyMainView;
  terminal?: TerminalRef;
}

function isTerminalRef(value: unknown): value is TerminalRef {
  return !!value && typeof value === 'object'
    && typeof (value as Record<string, unknown>).serverName === 'string'
    && typeof (value as Record<string, unknown>).target === 'string';
}

// Back-compat: earlier versions stored a bare MainView string, or a { view, terminal? }
// object, per task. New entries are always the { layout, focusedPaneId? } tree form below.
function normalizeLegacySubTabEntry(raw: unknown): LegacySubTabEntry {
  if (isLegacyMainView(raw)) return { view: raw };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      view: isLegacyMainView(obj.view) ? obj.view : 'description',
      terminal: isTerminalRef(obj.terminal) ? obj.terminal : undefined,
    };
  }
  return { view: 'description' };
}

export const FIXED_VIEWS = ['description', 'unit', 'git', 'summary', 'commits', 'diff'] as const;
export type FixedView = (typeof FIXED_VIEWS)[number];

function isFixedView(value: unknown): value is FixedView {
  return typeof value === 'string' && (FIXED_VIEWS as readonly string[]).includes(value);
}

export const VIEW_LABELS: Record<FixedView, string> = {
  description: 'Description', unit: 'Unit', git: 'Git', summary: 'Summary', commits: 'Commits', diff: 'Diff',
};

export function viewTabId(view: FixedView): string {
  return `view:${view}`;
}

export function parseViewTabId(tabId: string): FixedView | null {
  if (!tabId.startsWith('view:')) return null;
  const v = tabId.slice('view:'.length);
  return isFixedView(v) ? v : null;
}

// Window tab ids are keyed on the pane-suffix-stripped target (see utils/tmuxTarget) so
// the same tmux window always encodes to the same tab id regardless of which pane within
// it a caller happened to reference (task windows are stored as `session:window.1`; a pane
// click elsewhere in the same window produces `session:window.<paneIndex>`) — otherwise
// `allTabIds`/reconcile would treat those as two different tabs and prune whichever one the
// user actually had selected.
export function windowTabId(serverName: string, target: string): string {
  return `v-window:${serverName}/${stripPaneSuffix(target)}`;
}

export function parseWindowTabId(tabId: string): TerminalRef | null {
  if (!tabId.startsWith('v-window:')) return null;
  const rest = tabId.slice('v-window:'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  return { serverName: rest.slice(0, slashIdx), target: rest.slice(slashIdx + 1) };
}

export interface BrowserTabRef {
  serverName: string;
  pageId: string;
}

// Task-scoped CDP browser tabs (feature addition alongside Issue #397's window tabs):
// unlike windows, each `v-browser:` tab is a brand-new instance created on demand from the
// ＋ menu (never deduped/reused by serverName — the pageId makes every instance unique), so
// there's no `parse → look up in a fixed list` step needed the way windowTabId's `windows`
// lookup has; the tab id alone carries everything BrowserView needs to render.
export function browserTabId(serverName: string, pageId: string): string {
  return `v-browser:${serverName}/${pageId}`;
}

export function parseBrowserTabId(tabId: string): BrowserTabRef | null {
  if (!tabId.startsWith('v-browser:')) return null;
  const rest = tabId.slice('v-browser:'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  return { serverName: rest.slice(0, slashIdx), pageId: rest.slice(slashIdx + 1) };
}

function legacyEntryToTabId(raw: unknown): string {
  const legacy = normalizeLegacySubTabEntry(raw);
  if (legacy.view === 'window' && legacy.terminal) {
    return windowTabId(legacy.terminal.serverName, legacy.terminal.target);
  }
  return viewTabId(legacy.view === 'window' ? 'description' : legacy.view);
}

export interface PersistedTaskLayoutValue {
  root: unknown;
  focusedPaneId?: string;
}

/**
 * Re-encodes any `v-window:...` tab id found in a raw (not-yet-validated)
 * persisted layout node through `windowTabId()`'s current (pane-suffix-
 * stripped) normalization, so a tree persisted before that normalization was
 * introduced still lines up with tab ids built fresh from `windows` (see
 * `windowTabId`'s doc comment). Non-window tab ids and malformed nodes pass
 * through unchanged — full shape validation is `normalizeLayout`'s job.
 */
function normalizeWindowTabIdStr(tabId: string): string {
  const win = parseWindowTabId(tabId);
  return win ? windowTabId(win.serverName, win.target) : tabId;
}

function normalizeWindowTabIdsInRawNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if (obj.type === 'pane') {
    const tabIds = Array.isArray(obj.tabIds)
      ? obj.tabIds.map((t) => (typeof t === 'string' ? normalizeWindowTabIdStr(t) : t))
      : obj.tabIds;
    const activeTabId = typeof obj.activeTabId === 'string' ? normalizeWindowTabIdStr(obj.activeTabId) : obj.activeTabId;
    return { ...obj, tabIds, activeTabId };
  }
  if (obj.type === 'split') {
    return { ...obj, a: normalizeWindowTabIdsInRawNode(obj.a), b: normalizeWindowTabIdsInRawNode(obj.b) };
  }
  return obj;
}

/**
 * Normalizes one raw entry from the `SUB_TAB_KEY` map (per taskId) into the
 * `{ root, focusedPaneId }` shape `usePaneLayout`'s storage contract expects.
 * Recognizes the current `{ layout, focusedPaneId? }` shape as-is (re-keying
 * any window tab id inside it through the current pane-suffix-stripped
 * normalization), and migrates the legacy `{ view, terminal? }` / bare-string
 * shape into a single-pane tree containing just the fixed description anchor
 * plus (when the legacy entry pointed at a window) that window's tab.
 */
export function normalizePersistedTaskLayout(entry: unknown): PersistedTaskLayoutValue | null {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'object' && 'layout' in (entry as Record<string, unknown>)) {
    const obj = entry as Record<string, unknown>;
    return {
      root: normalizeWindowTabIdsInRawNode(obj.layout),
      focusedPaneId: typeof obj.focusedPaneId === 'string' ? obj.focusedPaneId : undefined,
    };
  }
  const activeTabId = legacyEntryToTabId(entry);
  // Seed every fixed view (not just description) so a task-scoped tab that's
  // unavailable for this task (e.g. no unit yet) is dropped by the ready
  // windowsReady/allTabIds-sync reconcile (prune-only against the currently
  // available set) rather than the tab having never existed in the tree —
  // `appendMissing: false` means a tab absent from the seed here can never
  // reappear later. `activeTabId` is appended too when it's a window tab (not
  // already covered by the fixed-view seed).
  const allViewTabIds = FIXED_VIEWS.map(viewTabId);
  const tabIds = allViewTabIds.includes(activeTabId) ? allViewTabIds : [...allViewTabIds, activeTabId];
  return {
    root: { type: 'pane', id: 'p1', tabIds, activeTabId },
    focusedPaneId: 'p1',
  };
}

function readSubTabMap(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SUB_TAB_KEY);
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeSubTabMap(map: Record<string, unknown>, keepKey?: string): void {
  try {
    const keys = Object.keys(map);
    if (keys.length > SUB_TAB_MAX_ENTRIES) {
      const getUpdatedAt = (k: string) => {
        const v = map[k] as { updatedAt?: unknown } | null;
        return typeof v?.updatedAt === 'number' ? v.updatedAt : 0;
      };
      const victims = keys
        .filter((k) => k !== keepKey)
        .sort((a, b) => getUpdatedAt(a) - getUpdatedAt(b))
        .slice(0, keys.length - SUB_TAB_MAX_ENTRIES);
      victims.forEach((k) => delete map[k]);
    }
    localStorage.setItem(SUB_TAB_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** Per-task storage adapter for `usePaneLayout`, backed by the shared `SUB_TAB_KEY` map. */
/**
 * The state a brand-new task (nothing ever persisted for it) starts from:
 * every currently-available fixed view tab, description active — no window
 * tabs. Windows are opened explicitly (window click / ＋ menu) rather than
 * auto-populated, matching how closed tabs behave once `appendMissing` is
 * off (see `reconcile` in paneLayoutTree.ts): a task-scoped layout only ever
 * gains tabs a user action asked for.
 *
 * Built directly (rather than leaning on `usePaneLayout`'s own
 * `initialTabIds` fallback, which always activates the *last* tab id) so the
 * tab order and the default active tab can be chosen independently.
 */
export function buildDefaultTaskLayout(defaultViewTabIds: string[]): PersistedTaskLayoutValue {
  const descriptionTabId = viewTabId('description');
  const tabIds = defaultViewTabIds.includes(descriptionTabId) ? defaultViewTabIds : [descriptionTabId, ...defaultViewTabIds];
  return {
    root: { type: 'pane', id: 'p1', tabIds, activeTabId: descriptionTabId },
    focusedPaneId: 'p1',
  };
}

/**
 * Per-task storage adapter for `usePaneLayout`, backed by the shared
 * `SUB_TAB_KEY` map. `defaultViewTabIds` (the fixed views currently available
 * for this task) seeds the very first ever layout for a task that has never
 * persisted one — read once, at the moment `usePaneLayout` actually calls
 * `load()` (mount / storageKey change), so a stale snapshot from an earlier
 * render never matters.
 */
export function makeTaskLayoutStorage(taskId: number, defaultViewTabIds: string[]): PaneLayoutStorage {
  return {
    load: () => normalizePersistedTaskLayout(readSubTabMap()[String(taskId)]) ?? buildDefaultTaskLayout(defaultViewTabIds),
    save: (value: unknown) => {
      const v = value as { root?: unknown; focusedPaneId?: string | null };
      const map = readSubTabMap();
      map[String(taskId)] = { layout: v.root, focusedPaneId: v.focusedPaneId ?? undefined, updatedAt: Date.now() };
      writeSubTabMap(map, String(taskId));
    },
  };
}

/**
 * Resolves the terminal this task's panel is actually displaying: the focused pane's
 * active window tab from the per-task persisted layout (same localStorage entry
 * TaskPanel itself uses, including the legacy-entry migration) when it still matches
 * one of the task's windows, otherwise the primary (or first) window. Used by the
 * mobile keyboard overlay to send keys to the pane the user is looking at on a task tab.
 */
export function resolveDisplayedTaskTerminal(
  taskId: number,
  windows: Window[],
): { serverName: string; target: string } | null {
  try {
    const normalized = normalizePersistedTaskLayout(readSubTabMap()[String(taskId)]);
    const root = normalized ? normalizeLayout(normalized.root) : null;
    if (root) {
      const focusedPane = normalized?.focusedPaneId ? findPane(root, normalized.focusedPaneId) : null;
      const pane = focusedPane ?? listPanes(root)[0];
      const activeTabId = pane?.activeTabId ?? null;
      const parsed = activeTabId ? parseWindowTabId(activeTabId) : null;
      // `parsed.target` is the pane-suffix-stripped id encoded into the tab id (see
      // windowTabId's doc comment) — resolve the window's actual `tmuxTarget` (which does
      // carry a pane suffix) so a key sent via the mobile overlay lands on the right pane.
      const matched = parsed && windows.find((w) => w.serverName === parsed.serverName && isSameWindowTarget(w.tmuxTarget, parsed.target));
      if (matched) return { serverName: matched.serverName, target: matched.tmuxTarget };
    }
  } catch { /* fall through to primary */ }
  const primary = windows.find((w) => w.isPrimary)
    ?? windows.reduce<Window | undefined>((latest, w) => (!latest || w.id > latest.id) ? w : latest, undefined);
  return primary ? { serverName: primary.serverName, target: primary.tmuxTarget } : null;
}

/**
 * Every `v-browser:` tab id present anywhere in the persisted layout tree for `taskId`,
 * deduplicated. Browser tabs are ephemeral/user-created (unlike windows, which come from
 * the server) — TaskPanel has no other source of truth for "which browser instances does
 * this task's layout currently reference" than the tree itself, so it seeds its own local
 * browser-tab-id state from this at mount (and on taskId change), *before* `usePaneLayout`'s
 * `allTabIds`-sync reconcile ever runs. That ordering matters: reconcile prunes any tab id
 * absent from `allTabIds` regardless of `appendMissing`, so a persisted browser tab not
 * included there would be deleted the instant `allTabIds`'s reference next changes (e.g. the
 * windows-list poll) — same hazard `windowsReady`/`ready` protects windows from, but browser
 * tabs have no equivalent "fetch resolved" gate since there's nothing to fetch.
 */
export function listPersistedBrowserTabIds(taskId: number): string[] {
  const normalized = normalizePersistedTaskLayout(readSubTabMap()[String(taskId)]);
  if (!normalized) return [];
  const root = normalizeLayout(normalized.root);
  if (!root) return [];
  const ids = new Set<string>();
  for (const pane of listPanes(root)) {
    for (const t of pane.tabIds) {
      if (t.startsWith('v-browser:')) ids.add(t);
    }
  }
  return Array.from(ids);
}

export const SELECT_BROWSER_EVENT = 'azito:select-task-browser';
export const SELECT_TERMINAL_EVENT = 'azito:select-task-terminal';

/**
 * browser:opened イベント受信時にタスクの paneLayout にブラウザタブを追加する。
 * 既に同じ groupId のタブがあればアクティブ化のみ。
 */
export function addBrowserToTaskLayout(taskId: number, serverName: string, groupId: string): void {
  const tabId = browserTabId(serverName, groupId);
  try {
    const map = readSubTabMap();
    const normalized = normalizePersistedTaskLayout(map[String(taskId)]);
    const baseRoot = normalized ? normalizeLayout(normalized.root) : null;
    let root: LayoutNode;
    let focusedPaneId: string;
    if (baseRoot) {
      const opened = openTab(baseRoot, tabId, normalized?.focusedPaneId ?? null);
      root = opened.root;
      focusedPaneId = opened.paneId;
    } else {
      const allViewTabIds = FIXED_VIEWS.map(viewTabId);
      const pane = createPane([...allViewTabIds, tabId], tabId);
      root = pane;
      focusedPaneId = pane.id;
    }
    map[String(taskId)] = { layout: root, focusedPaneId, updatedAt: Date.now() };
    writeSubTabMap(map, String(taskId));
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(SELECT_BROWSER_EVENT, { detail: { taskId, tabId } }));
}

/**
 * 外部（例: ActiveWindowsSection）から「このタスクのこのウィンドウを表示する」選択を行う。
 * localStorage に永続化し（未マウントの TaskPanel はマウント時の復元effectで読む）、
 * 既にマウント済みの TaskPanel には CustomEvent で即時反映を通知する。
 * 呼び出し側は本関数 → openTask の順で呼ぶこと。
 */
export function selectTaskTerminal(taskId: number, terminal: { serverName: string; target: string }): void {
  const tabId = windowTabId(terminal.serverName, terminal.target);
  try {
    const map = readSubTabMap();
    const normalized = normalizePersistedTaskLayout(map[String(taskId)]);
    const baseRoot = normalized ? normalizeLayout(normalized.root) : null;
    let root: LayoutNode;
    let focusedPaneId: string;
    if (baseRoot) {
      const opened = openTab(baseRoot, tabId, normalized?.focusedPaneId ?? null);
      root = opened.root;
      focusedPaneId = opened.paneId;
    } else {
      // No layout ever persisted for this task yet: seed every fixed view alongside the
      // selected window tab (same rationale as normalizePersistedTaskLayout's legacy-entry
      // migration below) so Description etc. aren't permanently "closed" under
      // `appendMissing: false` before the task's own layout ever gets a chance to exist.
      const allViewTabIds = FIXED_VIEWS.map(viewTabId);
      const pane = createPane([...allViewTabIds, tabId], tabId);
      root = pane;
      focusedPaneId = pane.id;
    }
    map[String(taskId)] = { layout: root, focusedPaneId, updatedAt: Date.now() };
    writeSubTabMap(map, String(taskId));
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(SELECT_TERMINAL_EVENT, { detail: { taskId, tabId } }));
}

export interface WindowContextExtra {
  online: boolean;
  windowName?: string;
  paneTarget?: string;
  paneTitle?: string;
}

/**
 * Resolves the `{ online, windowName, paneTarget, paneTitle }` metadata
 * `useWindowActions#getWindowMenuItems` needs to build a window's full
 * context menu (rename window/pane, capture panes, respawn, ...) — mirrors
 * `WindowPaneTree`'s own session/window/pane matching (single-pane branch),
 * since a task-scoped window tab always addresses one specific window.
 */
export function resolveWindowContextExtra(w: Window, sessionData: Record<string, Session[]>): WindowContextExtra {
  const sessions = sessionData[w.serverName] || [];
  const parts = w.tmuxTarget.split(':');
  const sessionName = parts[0];
  const rest = parts[1] ?? '';
  const dotIdx = rest.indexOf('.');
  const winPart = dotIdx >= 0 ? rest.slice(0, dotIdx) : rest || null;
  const paneIdxPart = dotIdx >= 0 ? rest.slice(dotIdx + 1) : null;

  const session = sessions.find((s) => s.name === sessionName);
  if (!session) return { online: false };

  let matchedWindows = winPart != null
    ? session.windows.filter((sw) => {
        const idx = parseInt(winPart, 10);
        return Number.isNaN(idx) ? sw.name === winPart : sw.index === idx;
      })
    : session.windows;
  if (matchedWindows.length === 0 && w.label) {
    matchedWindows = session.windows.filter((sw) => sw.name === w.label);
  }
  const sw = matchedWindows[0];
  if (!sw) return { online: false };

  const pane = paneIdxPart != null
    ? sw.panes.find((p) => String(p.index) === paneIdxPart) ?? sw.panes[0]
    : sw.panes[0];
  if (!pane) return { online: true, windowName: sw.name };

  const paneTarget = `${sessionName}:${sw.name}.${pane.index}`;
  const paneTitle = pane.title && pane.title !== pane.command ? pane.title : pane.command;
  return { online: true, windowName: sw.name, paneTarget, paneTitle };
}
