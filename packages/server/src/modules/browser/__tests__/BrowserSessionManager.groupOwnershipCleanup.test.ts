import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserSessionManager } from '../BrowserSessionManager';

// Issue #28 review fix 4: `browser_groups` ownership rows must be cleaned
// up on the two paths that destroy a group/session WITHOUT ever going
// through `BrowserSessionManager.closeGroup()` (the only place that used to
// clear ownership, via routes.ts's own explicit `remove()` call after a
// confirmed close):
//   1. A whole-session stop (`POST /api/browser/stop` or the idle session
//      timeout) — every group that session held is gone, so every
//      ownership row scoped to that server is stale.
//   2. BrowserSession's own idle-TTL group sweeper closing an individual
//      group in the background (no REST call ever reaches this hub for
//      that path — see BrowserSession.sweepIdleGroups's doc comment).

vi.mock('../BrowserSession', () => {
  class MockBrowserSession {
    running = false;
    _clientCount = 0;
    emitter = new EventEmitter();
    tabsByGroup = new Map<string, { tabId: string; url: string | null }[]>();

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
      const existing = this.tabsByGroup.get(groupId) ?? [];
      this.tabsByGroup.set(groupId, [...existing, { tabId, url: null }]);
      this.emitter.emit('group-tabs-changed', groupId);
      return { dispatchInput: vi.fn(async () => {}) };
    });

    // Test helper: simulates BrowserSession's own idle-TTL sweeper closing
    // a group in the background, with no explicit REST call driving it —
    // the real sweepIdleGroups() calls this.closeGroup(groupId) (no
    // `force`) internally on the same emitter path.
    simulateIdleTtlClose(groupId: string) {
      this.tabsByGroup.delete(groupId);
      this.emitter.emit('group-tabs-changed', groupId);
    }

    constructor(_opts: unknown) {}
  }
  return { BrowserSession: MockBrowserSession };
});

function makeBrowserGroupRepo() {
  return {
    recordOwner: vi.fn(),
    findOwnerTaskId: vi.fn(() => null),
    remove: vi.fn(),
    removeAllForServer: vi.fn(),
  };
}

describe('BrowserSessionManager browser_groups ownership cleanup (Issue #28 review fix 4)', () => {
  let browserGroupRepo: ReturnType<typeof makeBrowserGroupRepo>;
  let manager: BrowserSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    browserGroupRepo = makeBrowserGroupRepo();
    manager = new BrowserSessionManager('/tmp/test-profiles', undefined, browserGroupRepo as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop(serverName) clears every ownership row scoped to that server', async () => {
    await manager.getOrCreate('srv1');

    await manager.stop('srv1');

    expect(browserGroupRepo.removeAllForServer).toHaveBeenCalledWith('srv1');
  });

  it('stop(serverName) still clears ownership rows even when no live session exists for that server', async () => {
    await manager.stop('srv-never-launched');

    expect(browserGroupRepo.removeAllForServer).toHaveBeenCalledWith('srv-never-launched');
  });

  it("an idle-TTL group sweep (no explicit close-group call) removes that group's ownership row", async () => {
    const session = await manager.getOrCreate('srv1');
    await session.getOrCreatePage('groupA', 'tab1');

    (session as unknown as { simulateIdleTtlClose: (g: string) => void }).simulateIdleTtlClose('groupA');

    expect(browserGroupRepo.remove).toHaveBeenCalledWith('srv1', 'groupA');
  });

  it('does not remove an ownership row for a group whose tabs are still live', async () => {
    const session = await manager.getOrCreate('srv1');
    await session.getOrCreatePage('groupB', 'tab1');

    expect(browserGroupRepo.remove).not.toHaveBeenCalledWith('srv1', 'groupB');
  });
});
