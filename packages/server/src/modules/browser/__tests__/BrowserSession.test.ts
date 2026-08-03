import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserSessionManager } from '../BrowserSessionManager';

vi.mock('../BrowserSession', () => {
  class MockBrowserSession {
    running = false;
    _clientCount = 0;
    emitter = new EventEmitter();
    tabsByGroup = new Map<string, { tabId: string; url: string | null }[]>();
    pagesByKey = new Map<string, { dispatchInput: ReturnType<typeof vi.fn> }>();

    get totalClientCount() { return this._clientCount; }

    start = vi.fn(async () => { this.running = true; });
    stop = vi.fn(async () => { this.running = false; });
    pages = vi.fn(() => []);
    keepaliveGroup = vi.fn();
    closeGroup = vi.fn(async (groupId: string) => {
      this.tabsByGroup.delete(groupId);
      this.emitter.emit('group-tabs-changed', groupId);
    });
    onGroupTabsChanged = vi.fn((listener: (groupId: string) => void) => {
      this.emitter.on('group-tabs-changed', listener);
      return () => { this.emitter.off('group-tabs-changed', listener); };
    });
    listGroupTabs = vi.fn((groupId: string) => this.tabsByGroup.get(groupId) ?? []);
    getOrCreatePage = vi.fn(async (groupId: string, tabId: string) => {
      const key = `${groupId}/${tabId}`;
      let page = this.pagesByKey.get(key);
      if (!page) {
        page = { dispatchInput: vi.fn(async () => {}) };
        this.pagesByKey.set(key, page);
      }
      const existing = this.tabsByGroup.get(groupId) ?? [];
      if (!existing.some((t) => t.tabId === tabId)) {
        this.tabsByGroup.set(groupId, [...existing, { tabId, url: null }]);
        this.emitter.emit('group-tabs-changed', groupId);
      }
      return page;
    });

    // Test helper: simulates a page's URL becoming known (e.g. after
    // navigation), the way the real BrowserSession broadcasts on page.onUrl.
    setTabUrl(groupId: string, tabId: string, url: string) {
      const tabs = this.tabsByGroup.get(groupId) ?? [];
      this.tabsByGroup.set(groupId, tabs.map((t) => t.tabId === tabId ? { ...t, url } : t));
      this.emitter.emit('group-tabs-changed', groupId);
    }

    constructor(_opts: unknown) {}
  }
  return { BrowserSession: MockBrowserSession };
});

// The manager's public API is typed against the real BrowserSession, which
// has no `.mock` on its methods — cast through this helper to reach the
// vi.fn() mock bookkeeping (call counts, mock.calls, ...) on the mocked
// instance actually returned by getOrCreate() in this suite.
function asMock(session: unknown) {
  return session as unknown as {
    getOrCreatePage: ReturnType<typeof vi.fn>;
    listGroupTabs: ReturnType<typeof vi.fn>;
    setTabUrl: (groupId: string, tabId: string, url: string) => void;
    tabsByGroup: Map<string, unknown>;
    emitter: EventEmitter;
  };
}

describe('BrowserSessionManager', () => {
  let manager: BrowserSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new BrowserSessionManager('/tmp/test-profiles');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a session on getOrCreate', async () => {
    const session = await manager.getOrCreate('test-server');
    expect(session.running).toBe(true);
    expect(session.start).toHaveBeenCalled();
  });

  it('returns existing session on second getOrCreate', async () => {
    const s1 = await manager.getOrCreate('test-server');
    const s2 = await manager.getOrCreate('test-server');
    expect(s1).toBe(s2);
  });

  it('getStatus returns running state', async () => {
    expect(manager.getStatus('test-server')).toEqual({ running: false, clientCount: 0, pages: [] });
    await manager.getOrCreate('test-server');
    expect(manager.getStatus('test-server')).toEqual({ running: true, clientCount: 0, pages: [] });
  });

  it('stop removes the session', async () => {
    const session = await manager.getOrCreate('test-server');
    await manager.stop('test-server');
    expect(session.stop).toHaveBeenCalled();
    expect(manager.getStatus('test-server')).toEqual({ running: false, clientCount: 0, pages: [] });
  });

  it('checkIdle starts idle timer when clientCount is 0', async () => {
    const session = await manager.getOrCreate('test-server');
    manager.checkIdle('test-server');

    vi.advanceTimersByTime(15 * 60 * 1000);
    await vi.runAllTimersAsync();

    expect(session.stop).toHaveBeenCalled();
  });

  it('checkIdle cancels timer when client connects', async () => {
    const session = await manager.getOrCreate('test-server');
    manager.checkIdle('test-server');

    (session as unknown as { _clientCount: number })._clientCount = 1;
    manager.checkIdle('test-server');

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(session.stop).not.toHaveBeenCalled();
  });

  it('stopAll stops all sessions', async () => {
    const s1 = await manager.getOrCreate('server-1');
    const s2 = await manager.getOrCreate('server-2');
    await manager.stopAll();
    expect(s1.stop).toHaveBeenCalled();
    expect(s2.stop).toHaveBeenCalled();
  });

  describe('keepalive', () => {
    it('forwards keepalive to the session for each group', async () => {
      const session = await manager.getOrCreate('test-server');
      manager.keepalive('test-server', ['g1', 'g2']);
      expect(session.keepaliveGroup).toHaveBeenCalledWith('g1');
      expect(session.keepaliveGroup).toHaveBeenCalledWith('g2');
    });

    it('is a no-op when the session does not exist', () => {
      expect(() => manager.keepalive('no-such-server', ['g1'])).not.toThrow();
    });
  });

  describe('closeGroup', () => {
    it('closes the group on the session and re-checks instance idle', async () => {
      const session = await manager.getOrCreate('test-server');
      await manager.closeGroup('test-server', 'g1');
      expect(session.closeGroup).toHaveBeenCalledWith('g1', { force: true });
    });

    it('is a no-op on the session when it does not exist, but still clears any snapshot', async () => {
      await expect(manager.closeGroup('no-such-server', 'g1')).resolves.toBeUndefined();
    });

    it('deletes the snapshot for the closed group (explicit close), so restoreGroupIfEmpty finds nothing', async () => {
      const session = await manager.getOrCreate('test-server');
      await session.getOrCreatePage('g1', 't1');
      asMock(session).setTabUrl('g1', 't1', 'https://example.com');

      await manager.closeGroup('test-server', 'g1');

      const callsBefore = asMock(session).getOrCreatePage.mock.calls.length;
      await manager.restoreGroupIfEmpty(session, 'test-server', 'g1');
      expect(asMock(session).getOrCreatePage.mock.calls.length).toBe(callsBefore);
    });
  });

  describe('snapshot + restoreGroupIfEmpty', () => {
    it('keeps the snapshot when the group empties via TTL-style closure (not explicit closeGroup)', async () => {
      const session = await manager.getOrCreate('test-server');
      await session.getOrCreatePage('g1', 't1');
      asMock(session).setTabUrl('g1', 't1', 'https://example.com');

      // Simulate the sweeper closing every tab in the group directly on the
      // session (bypassing manager.closeGroup, which is the "explicit close"
      // path) — this is what BrowserSession's own TTL sweep does.
      asMock(session).tabsByGroup.delete('g1');
      asMock(session).emitter.emit('group-tabs-changed', 'g1');

      expect(manager.getSnapshot('test-server', 'g1')).toEqual([{ tabId: 't1', url: 'https://example.com' }]);
    });

    it('restoreGroupIfEmpty recreates tabs from the snapshot and navigates each to its last URL', async () => {
      const session = await manager.getOrCreate('test-server');
      await session.getOrCreatePage('g1', 't1');
      asMock(session).setTabUrl('g1', 't1', 'https://example.com/a');
      await session.getOrCreatePage('g1', 't2'); // url stays null (no navigation yet)

      // Group empties out (TTL-style, snapshot preserved).
      asMock(session).tabsByGroup.delete('g1');
      asMock(session).emitter.emit('group-tabs-changed', 'g1');
      expect(session.listGroupTabs('g1')).toEqual([]);

      await manager.restoreGroupIfEmpty(session, 'test-server', 'g1');

      expect(session.getOrCreatePage).toHaveBeenCalledWith('g1', 't1');
      expect(session.getOrCreatePage).toHaveBeenCalledWith('g1', 't2');
      const pageT1 = await session.getOrCreatePage('g1', 't1');
      const pageT2 = await session.getOrCreatePage('g1', 't2');
      expect(pageT1.dispatchInput).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com/a' });
      expect(pageT2.dispatchInput).not.toHaveBeenCalled(); // null url -> no navigate
    });

    it('restoreGroupIfEmpty is a no-op when the group already has live tabs', async () => {
      const session = await manager.getOrCreate('test-server');
      await session.getOrCreatePage('g1', 't1');
      const callsBefore = asMock(session).getOrCreatePage.mock.calls.length;

      await manager.restoreGroupIfEmpty(session, 'test-server', 'g1');

      expect(asMock(session).getOrCreatePage.mock.calls.length).toBe(callsBefore);
    });

    it('restoreGroupIfEmpty is a no-op when there is no snapshot for the group', async () => {
      const session = await manager.getOrCreate('test-server');
      await manager.restoreGroupIfEmpty(session, 'test-server', 'never-opened');
      expect(session.getOrCreatePage).not.toHaveBeenCalled();
    });
  });
});
