import { describe, it, expect, afterEach } from 'vitest';
import type { Window, Session } from '../../pages/workspace/types';
import {
  normalizePersistedTaskLayout,
  buildDefaultTaskLayout,
  resolveWindowContextExtra,
  viewTabId,
  parseViewTabId,
  windowTabId,
  parseWindowTabId,
  browserTabId,
  parseBrowserTabId,
  listPersistedBrowserTabIds,
  selectTaskTerminal,
  resolveDisplayedTaskTerminal,
  makeTaskLayoutStorage,
  SUB_TAB_KEY,
} from './taskPaneLayout';

function makeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 1, ownerType: 'task', serverName: 'local', tmuxTarget: 'sess:1.0',
    isPrimary: true, windowType: 'terminal',
    ...overrides,
  };
}

// Every fixed view (not just description) is seeded, not only the legacy entry's own view
// / the explicitly-selected window — appendMissing: false means a tab absent from the
// initial seed can never reappear once windowsReady's reconcile prunes against the task's
// actually-available views, so an unseeded view would stay permanently "closed". A view
// unavailable for this task (e.g. no unit yet) is safely dropped later by that prune-only
// reconcile.
const allFixedViewTabIds = ['view:description', 'view:unit', 'view:git', 'view:summary', 'view:commits', 'view:diff'];

describe('viewTabId / parseViewTabId', () => {
  it('round-trips a fixed view into its tab id', () => {
    expect(viewTabId('description')).toBe('view:description');
    expect(parseViewTabId('view:description')).toBe('description');
    expect(parseViewTabId('view:git')).toBe('git');
  });

  it('rejects non-view or unknown-view tab ids', () => {
    expect(parseViewTabId('v-window:local::sess:1')).toBeNull();
    expect(parseViewTabId('view:not-a-real-view')).toBeNull();
  });
});

describe('windowTabId / parseWindowTabId', () => {
  it('round-trips a server+target pair into its tab id, stripping any pane suffix', () => {
    const tabId = windowTabId('local', 'sess:1.0');
    expect(tabId).toBe('v-window:local::sess:1');
    expect(parseWindowTabId(tabId)).toEqual({ serverName: 'local', target: 'sess:1' });
  });

  it('encodes two targets that differ only by pane suffix to the same tab id', () => {
    expect(windowTabId('local', 'sess:main.1')).toBe(windowTabId('local', 'sess:main.0'));
  });

  it('parses new format (:: separator)', () => {
    expect(parseWindowTabId('v-window:local::main:0')).toEqual({ serverName: 'local', target: 'main:0' });
    expect(parseWindowTabId('v-window:srv01::azito:win--abc')).toEqual({ serverName: 'srv01', target: 'azito:win--abc' });
  });

  it('parses old format (/ separator) for backward compatibility', () => {
    expect(parseWindowTabId('v-window:local/main:0')).toEqual({ serverName: 'local', target: 'main:0' });
    expect(parseWindowTabId('v-window:srv01/azito:win--abc')).toEqual({ serverName: 'srv01', target: 'azito:win--abc' });
  });

  it('rejects malformed window tab ids', () => {
    expect(parseWindowTabId('view:description')).toBeNull();
    expect(parseWindowTabId('v-window:')).toBeNull();
    expect(parseWindowTabId('v-window:missing-separator')).toBeNull();
  });
});

describe('browserTabId / parseBrowserTabId', () => {
  it('round-trips a server+pageId pair into its tab id', () => {
    const tabId = browserTabId('local', 'abc123-xyz');
    expect(tabId).toBe('v-browser:local/abc123-xyz');
    expect(parseBrowserTabId(tabId)).toEqual({ serverName: 'local', pageId: 'abc123-xyz' });
  });

  it('rejects malformed browser tab ids', () => {
    expect(parseBrowserTabId('view:description')).toBeNull();
    expect(parseBrowserTabId('v-browser:')).toBeNull();
    expect(parseBrowserTabId('v-browser:missing-slash')).toBeNull();
    expect(parseBrowserTabId('v-window:local::sess:1')).toBeNull();
  });
});

describe('listPersistedBrowserTabIds', () => {
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  function stubLocalStorage(store: Record<string, string>) {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
  }

  it('returns an empty array when nothing is persisted for the task', () => {
    stubLocalStorage({});
    expect(listPersistedBrowserTabIds(99)).toEqual([]);
  });

  it('collects every v-browser tab id in the persisted layout, deduplicated', () => {
    stubLocalStorage({
      [SUB_TAB_KEY]: JSON.stringify({
        7: {
          layout: {
            type: 'split', dir: 'row', ratio: 0.5,
            a: { type: 'pane', id: 'p1', tabIds: ['view:description', 'v-browser:local/g1'], activeTabId: 'v-browser:local/g1' },
            b: { type: 'pane', id: 'p2', tabIds: ['v-browser:local/g2'], activeTabId: 'v-browser:local/g2' },
          },
          focusedPaneId: 'p1',
        },
      }),
    });
    expect(listPersistedBrowserTabIds(7)).toEqual(['v-browser:local/g1', 'v-browser:local/g2']);
  });

  it('ignores non-browser tabs', () => {
    stubLocalStorage({
      [SUB_TAB_KEY]: JSON.stringify({
        3: {
          layout: { type: 'pane', id: 'p1', tabIds: ['view:description', 'v-window:local::sess:1'], activeTabId: 'view:description' },
          focusedPaneId: 'p1',
        },
      }),
    });
    expect(listPersistedBrowserTabIds(3)).toEqual([]);
  });
});

describe('normalizePersistedTaskLayout', () => {
  it('returns null for no persisted entry', () => {
    expect(normalizePersistedTaskLayout(undefined)).toBeNull();
    expect(normalizePersistedTaskLayout(null)).toBeNull();
  });

  it('passes the current { layout, focusedPaneId } shape through as { root, focusedPaneId }', () => {
    const layout = { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' };
    const result = normalizePersistedTaskLayout({ layout, focusedPaneId: 'p1' });
    expect(result).toEqual({ root: layout, focusedPaneId: 'p1' });
  });

  it('tolerates a missing focusedPaneId on the current shape', () => {
    const layout = { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' };
    const result = normalizePersistedTaskLayout({ layout });
    expect(result).toEqual({ root: layout, focusedPaneId: undefined });
  });

  it('migrates a legacy bare-string view into a single-pane tree seeded with every fixed view', () => {
    const result = normalizePersistedTaskLayout('git');
    expect(result).toEqual({
      root: { type: 'pane', id: 'p1', tabIds: allFixedViewTabIds, activeTabId: 'view:git' },
      focusedPaneId: 'p1',
    });
  });

  it('migrates a legacy { view: "description" } entry without duplicating the anchor tab', () => {
    const result = normalizePersistedTaskLayout({ view: 'description' });
    expect(result).toEqual({
      root: { type: 'pane', id: 'p1', tabIds: allFixedViewTabIds, activeTabId: 'view:description' },
      focusedPaneId: 'p1',
    });
  });

  it('migrates a legacy { view: "window", terminal } entry into the window tab id, alongside every fixed view', () => {
    const result = normalizePersistedTaskLayout({ view: 'window', terminal: { serverName: 'local', target: 'sess:1.0' } });
    expect(result).toEqual({
      root: {
        type: 'pane', id: 'p1',
        // terminal target's pane suffix (".0") is stripped by windowTabId's normalization.
        tabIds: [...allFixedViewTabIds, 'v-window:local::sess:1'],
        activeTabId: 'v-window:local::sess:1',
      },
      focusedPaneId: 'p1',
    });
  });

  it('falls back to description when a legacy "window" entry has no terminal', () => {
    const result = normalizePersistedTaskLayout({ view: 'window' });
    expect(result).toEqual({
      root: { type: 'pane', id: 'p1', tabIds: allFixedViewTabIds, activeTabId: 'view:description' },
      focusedPaneId: 'p1',
    });
  });

  it('falls back to description for a malformed entry', () => {
    const result = normalizePersistedTaskLayout({ unexpected: true });
    expect(result).toEqual({
      root: { type: 'pane', id: 'p1', tabIds: allFixedViewTabIds, activeTabId: 'view:description' },
      focusedPaneId: 'p1',
    });
  });

  it('re-normalizes a persisted window tab id that still carries a pane suffix from before windowTabId stripped it', () => {
    const layout = {
      type: 'pane', id: 'p1',
      tabIds: ['view:description', 'v-window:local/sess:main.1'],
      activeTabId: 'v-window:local/sess:main.1',
    };
    const result = normalizePersistedTaskLayout({ layout, focusedPaneId: 'p1' });
    expect(result).toEqual({
      root: {
        type: 'pane', id: 'p1',
        tabIds: ['view:description', 'v-window:local::sess:main'],
        activeTabId: 'v-window:local::sess:main',
      },
      focusedPaneId: 'p1',
    });
  });

  it('re-normalizes window tab ids nested inside a split tree', () => {
    const layout = {
      type: 'split', dir: 'row', ratio: 0.5,
      a: { type: 'pane', id: 'p1', tabIds: ['v-window:local/sess:main.1'], activeTabId: 'v-window:local/sess:main.1' },
      b: { type: 'pane', id: 'p2', tabIds: ['view:description'], activeTabId: 'view:description' },
    };
    const result = normalizePersistedTaskLayout({ layout, focusedPaneId: 'p2' });
    const root = result?.root as { a: { tabIds: string[]; activeTabId: string } };
    expect(root.a.tabIds).toEqual(['v-window:local::sess:main']);
    expect(root.a.activeTabId).toBe('v-window:local::sess:main');
  });
});

describe('selectTaskTerminal', () => {
  // selectTaskTerminal talks to `localStorage`/`window.dispatchEvent` directly (it's meant
  // to run from a browser event handler outside any mounted TaskPanel) — this project's
  // vitest config runs in the plain `node` environment (no jsdom), so stub just enough of
  // the browser surface it touches rather than pulling in a DOM environment for one test.
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalCustomEvent = (globalThis as { CustomEvent?: unknown }).CustomEvent;

  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { CustomEvent?: unknown }).CustomEvent = originalCustomEvent;
  });

  it('seeds a brand-new task (nothing ever persisted) with every fixed view alongside the selected window tab', () => {
    const store: Record<string, string> = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
    (globalThis as { CustomEvent?: unknown }).CustomEvent = class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
    (globalThis as { window?: unknown }).window = { dispatchEvent: () => true };

    selectTaskTerminal(42, { serverName: 'local', target: 'sess:main.1' });

    const map = JSON.parse(store[SUB_TAB_KEY]) as Record<string, { layout: { tabIds: string[]; activeTabId: string } }>;
    expect(map['42'].layout.tabIds).toEqual([...allFixedViewTabIds, 'v-window:local::sess:main']);
    expect(map['42'].layout.activeTabId).toBe('v-window:local::sess:main');
  });
});

describe('resolveDisplayedTaskTerminal', () => {
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  it('falls back to the newest window (highest id) when no primary and no persisted layout', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    const windows = [
      makeWindow({ id: 10, isPrimary: false, tmuxTarget: 'sess:oldest.1' }),
      makeWindow({ id: 20, isPrimary: false, tmuxTarget: 'sess:middle.1' }),
      makeWindow({ id: 30, isPrimary: false, tmuxTarget: 'sess:newest.1' }),
    ];
    expect(resolveDisplayedTaskTerminal(99, windows)).toEqual({ serverName: 'local', target: 'sess:newest.1' });
  });

  it('prefers primary over newest when primary exists', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    const windows = [
      makeWindow({ id: 10, isPrimary: false, tmuxTarget: 'sess:old.1' }),
      makeWindow({ id: 5, isPrimary: true, tmuxTarget: 'sess:primary.1' }),
      makeWindow({ id: 20, isPrimary: false, tmuxTarget: 'sess:newer.1' }),
    ];
    expect(resolveDisplayedTaskTerminal(99, windows)).toEqual({ serverName: 'local', target: 'sess:primary.1' });
  });

  it('resolves the persisted (pane-suffix-stripped) window tab id back to the window\'s real tmuxTarget', () => {
    const store: Record<string, string> = {
      [SUB_TAB_KEY]: JSON.stringify({
        7: {
          layout: { type: 'pane', id: 'p1', tabIds: ['v-window:local::sess:main'], activeTabId: 'v-window:local::sess:main' },
          focusedPaneId: 'p1',
        },
      }),
    };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
    const windows = [makeWindow({ serverName: 'local', tmuxTarget: 'sess:main.1' })];
    expect(resolveDisplayedTaskTerminal(7, windows)).toEqual({ serverName: 'local', target: 'sess:main.1' });
  });
});

describe('buildDefaultTaskLayout', () => {
  it('seeds a single pane with every available fixed view, description active', () => {
    const result = buildDefaultTaskLayout(['view:description', 'view:unit', 'view:git', 'view:diff']);
    expect(result).toEqual({
      root: {
        type: 'pane', id: 'p1',
        tabIds: ['view:description', 'view:unit', 'view:git', 'view:diff'],
        activeTabId: 'view:description',
      },
      focusedPaneId: 'p1',
    });
  });

  it('does not include any window tabs — only fixed views the caller passed in', () => {
    const result = buildDefaultTaskLayout(['view:description', 'view:unit']);
    const root = result.root as { tabIds: string[] };
    expect(root.tabIds.some((t) => t.startsWith('v-window:'))).toBe(false);
  });

  it('prepends description when the caller omits it', () => {
    const result = buildDefaultTaskLayout(['view:unit']);
    expect(result).toEqual({
      root: { type: 'pane', id: 'p1', tabIds: ['view:description', 'view:unit'], activeTabId: 'view:description' },
      focusedPaneId: 'p1',
    });
  });
});

describe('resolveWindowContextExtra', () => {
  const sessionData: Record<string, Session[]> = {
    local: [
      {
        name: 'sess',
        windows: [
          { index: 1, name: 'main', panes: [{ index: 0, title: 'my-title', command: 'bash', width: 80, height: 24, active: true }] },
        ],
      },
    ],
  };

  it('resolves online window/pane metadata for a matching single-pane window', () => {
    const w = makeWindow({ serverName: 'local', tmuxTarget: 'sess:1.0' });
    expect(resolveWindowContextExtra(w, sessionData)).toEqual({
      online: true, windowName: 'main', paneTarget: 'sess:main.0', paneTitle: 'my-title', paneCommand: 'bash',
    });
  });

  it('falls back to the pane command when the title equals the command', () => {
    const data: Record<string, Session[]> = {
      local: [{ name: 'sess', windows: [{ index: 1, name: 'main', panes: [{ index: 0, title: 'bash', command: 'bash', width: 80, height: 24, active: true }] }] }],
    };
    const w = makeWindow({ tmuxTarget: 'sess:1.0' });
    expect(resolveWindowContextExtra(w, data).paneTitle).toBe('bash');
  });

  it('reports offline when the session is not present in sessionData', () => {
    const w = makeWindow({ serverName: 'unknown-server' });
    expect(resolveWindowContextExtra(w, sessionData)).toEqual({ online: false });
  });

  it('reports offline when the window is not present in the matched session', () => {
    const w = makeWindow({ tmuxTarget: 'sess:99.0' });
    expect(resolveWindowContextExtra(w, sessionData)).toEqual({ online: false });
  });
});

describe('writeSubTabMap LRU eviction', () => {
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  function stubLocalStorage(store: Record<string, string>) {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
  }

  function buildMapWithEntries(count: number, updatedAtBase: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    for (let i = 100; i < 100 + count; i++) {
      map[String(i)] = {
        layout: { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' },
        focusedPaneId: 'p1',
        updatedAt: updatedAtBase + i,
      };
    }
    return map;
  }

  it('preserves the just-saved entry even when its taskId is the smallest (numeric key order)', () => {
    const store: Record<string, string> = {};
    const map = buildMapWithEntries(50, 1000);
    store[SUB_TAB_KEY] = JSON.stringify(map);
    stubLocalStorage(store);

    const storage = makeTaskLayoutStorage(1, allFixedViewTabIds);
    const layout = { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' };
    storage.save({ root: layout, focusedPaneId: 'p1' });

    const result = JSON.parse(store[SUB_TAB_KEY]) as Record<string, unknown>;
    expect(result['1']).toBeDefined();
    expect(Object.keys(result).length).toBe(50);
  });

  it('evicts the entry with the oldest updatedAt, not the smallest taskId', () => {
    const store: Record<string, string> = {};
    const map: Record<string, unknown> = {};
    for (let i = 200; i < 250; i++) {
      map[String(i)] = {
        layout: { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' },
        focusedPaneId: 'p1',
        updatedAt: i === 225 ? 1 : 5000,
      };
    }
    store[SUB_TAB_KEY] = JSON.stringify(map);
    stubLocalStorage(store);

    const storage = makeTaskLayoutStorage(999, allFixedViewTabIds);
    storage.save({ root: { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' }, focusedPaneId: 'p1' });

    const result = JSON.parse(store[SUB_TAB_KEY]) as Record<string, unknown>;
    expect(result['225']).toBeUndefined();
    expect(result['999']).toBeDefined();
    expect(result['200']).toBeDefined();
    expect(Object.keys(result).length).toBe(50);
  });

  it('evicts legacy entries (no updatedAt) before entries with updatedAt', () => {
    const store: Record<string, string> = {};
    const map: Record<string, unknown> = {};
    for (let i = 300; i < 350; i++) {
      if (i === 300) {
        map[String(i)] = {
          layout: { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' },
          focusedPaneId: 'p1',
        };
      } else {
        map[String(i)] = {
          layout: { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' },
          focusedPaneId: 'p1',
          updatedAt: 9000 + i,
        };
      }
    }
    store[SUB_TAB_KEY] = JSON.stringify(map);
    stubLocalStorage(store);

    const storage = makeTaskLayoutStorage(50, allFixedViewTabIds);
    storage.save({ root: { type: 'pane', id: 'p1', tabIds: ['view:description'], activeTabId: 'view:description' }, focusedPaneId: 'p1' });

    const result = JSON.parse(store[SUB_TAB_KEY]) as Record<string, unknown>;
    expect(result['300']).toBeUndefined();
    expect(result['50']).toBeDefined();
    expect(result['301']).toBeDefined();
    expect(Object.keys(result).length).toBe(50);
  });
});
