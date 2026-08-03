import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserSession } from '../BrowserSession';

// Mirrors the mock pattern used in BrowserSession.getOrCreatePage.test.ts:
// BrowserPage.start()/close() need a live browser, so we stub them out and
// only exercise BrowserSession's group idle-sweep bookkeeping here.
vi.mock('../BrowserPage', async () => {
  const actual = await vi.importActual('../BrowserPage');
  class MockBrowserPage {
    clientCount = 0;
    lastUrl = null;
    loading = false;
    title = null;
    start = vi.fn(async () => {});
    close = vi.fn(async () => {});
    onUrl = vi.fn(() => () => {});
    onLoading = vi.fn(() => () => {});
    onTitle = vi.fn(() => () => {});
    dispatchInput = vi.fn(async () => {});
    constructor(public rawPage: unknown) {}
  }
  return { ...actual, BrowserPage: MockBrowserPage };
});

describe('BrowserSession group TTL sweeper', () => {
  let session: BrowserSession;
  let newPageCallCount: number;
  const GROUP_TTL_MS = 5 * 60 * 1000;
  const GROUP_SWEEP_INTERVAL_MS = 60 * 1000;

  beforeEach(async () => {
    vi.useFakeTimers();
    session = new BrowserSession({ profileDir: '/tmp/test-profile' });
    newPageCallCount = 0;
    const fakeContext = {
      pages: () => [{ id: 'initial' }],
      newPage: vi.fn(async () => {
        newPageCallCount++;
        return { id: `new-${newPageCallCount}` };
      }),
    };
    (session as unknown as { context: unknown }).context = fakeContext;
    (session as unknown as { _running: boolean })._running = true;
    // start() normally kicks off the sweeper interval; the tests below set
    // `_running`/`context` directly (bypassing chromium.launchPersistentContext),
    // so wire the sweeper up the same way start() would.
    (session as unknown as { sweepTimer: unknown }).sweepTimer = setInterval(
      () => (session as unknown as { sweepIdleGroups: () => void }).sweepIdleGroups(),
      GROUP_SWEEP_INTERVAL_MS,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes all pages in a group once it has been unattended (0 clients, no keepalive) for the TTL', async () => {
    const pageA = await session.getOrCreatePage('group-a', 'tab-a');
    const pageB = await session.getOrCreatePage('group-a', 'tab-b');
    session.decrementGroupClient('group-a'); // simulate the connect->disconnect cycle leaving count at 0

    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS);

    expect(pageA.close).toHaveBeenCalled();
    expect(pageB.close).toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
    expect(session.getPage('group-a', 'tab-b')).toBeUndefined();
  });

  it('does not close pages in an unrelated (still-connected) group', async () => {
    await session.getOrCreatePage('group-a', 'tab-a');
    session.decrementGroupClient('group-a'); // group-a: 0 clients, eligible for expiry
    const otherPage = await session.getOrCreatePage('group-b', 'tab-a');
    session.incrementGroupClient('group-b'); // group-b: still has a connected client

    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS);

    expect(otherPage.close).not.toHaveBeenCalled();
    expect(session.getPage('group-b', 'tab-a')).toBe(otherPage);
  });

  it('does not close a group with a positive clientCount, regardless of lastSeen', async () => {
    const page = await session.getOrCreatePage('group-a', 'tab-a');
    session.incrementGroupClient('group-a');

    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS);

    expect(page.close).not.toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-a')).toBe(page);
  });

  it('keepaliveGroup extends the TTL, deferring closure', async () => {
    const page = await session.getOrCreatePage('group-a', 'tab-a');
    session.decrementGroupClient('group-a');

    // Just under the TTL, send a keepalive — this must reset the clock.
    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS - GROUP_SWEEP_INTERVAL_MS);
    session.keepaliveGroup('group-a');

    // Advance by another near-TTL span: without the keepalive this would
    // have closed the group (total elapsed since creation > TTL).
    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS - GROUP_SWEEP_INTERVAL_MS);
    expect(page.close).not.toHaveBeenCalled();

    // Now let it actually expire from the keepalive's baseline.
    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS);
    expect(page.close).toHaveBeenCalled();
  });

  it('keepaliveGroup on a nonexistent group is a no-op', () => {
    expect(() => session.keepaliveGroup('no-such-group')).not.toThrow();
  });

  it('closeGroup is a public method that tears a group down immediately, independent of the sweeper', async () => {
    const page = await session.getOrCreatePage('group-a', 'tab-a');
    await session.closeGroup('group-a');
    expect(page.close).toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
  });

  // Regression: an explicit close (e.g. the user closed the workspace
  // browser tab) races independently against the WS disconnect on the
  // frontend — close-group can arrive at the hub before the WS close does,
  // so clientCount can still read positive here even though no real
  // reconnect is happening. Without `force`, the "stop closing further tabs
  // once clientCount is positive again" guard (meant to protect a genuine
  // TTL-sweep-vs-reconnect race) would abort after tab-a and strand tab-b
  // open.
  it('force closes every tab in the group even with a positive clientCount', async () => {
    const pageA = await session.getOrCreatePage('group-a', 'tab-a');
    const pageB = await session.getOrCreatePage('group-a', 'tab-b');
    session.incrementGroupClient('group-a'); // simulates the WS close not having landed yet

    await session.closeGroup('group-a', { force: true });

    expect(pageA.close).toHaveBeenCalled();
    expect(pageB.close).toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
    expect(session.getPage('group-a', 'tab-b')).toBeUndefined();
  });

  it('non-forced closeGroup (unlike force) still aborts remaining closes when clientCount is positive', async () => {
    const pageA = await session.getOrCreatePage('group-a', 'tab-a');
    const pageB = await session.getOrCreatePage('group-a', 'tab-b');
    session.incrementGroupClient('group-a');

    await session.closeGroup('group-a');

    expect(pageA.close).toHaveBeenCalled();
    expect(pageB.close).not.toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-b')).toBe(pageB);
  });

  // Regression: closeGroup() closes each of a group's tabs sequentially,
  // `await`-ing page.close() between iterations. A reconnect racing in
  // during that window used to be able to (a) have its freshly (re)created
  // page torn down by a later loop iteration still working off a stale
  // snapshot, or (b) have its positive clientCount silently deleted at the
  // end of the loop.
  describe('closeGroup race with a mid-loop reconnect', () => {
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    }

    it('does not close a page that was replaced by a reconnect mid-loop (stale snapshot instance)', async () => {
      const pageA = await session.getOrCreatePage('group-a', 'tab-a');
      const pageBOriginal = await session.getOrCreatePage('group-a', 'tab-b');

      const aClose = deferred<void>();
      (pageA as unknown as { close: () => Promise<void> }).close = vi.fn(() => aClose.promise);

      const closePromise = session.closeGroup('group-a');

      // While tab-a's close is still in flight, something else (e.g. a
      // reconnect that explicitly reopens the tab) closes and recreates
      // tab-b, so the live instance no longer matches closeGroup's snapshot.
      await session.closePage('group-a', 'tab-b');
      const pageBNew = await session.getOrCreatePage('group-a', 'tab-b');
      expect(pageBNew).not.toBe(pageBOriginal);

      aClose.resolve();
      await closePromise;

      expect(pageA.close).toHaveBeenCalled();
      expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
      // The stale snapshot must not close the new tab-b instance.
      expect((pageBNew as unknown as { close: () => void }).close).not.toHaveBeenCalled();
      expect(session.getPage('group-a', 'tab-b')).toBe(pageBNew);
    });

    it('aborts remaining closes once a client reconnects mid-loop, and keeps the positive client count', async () => {
      const pageA = await session.getOrCreatePage('group-a', 'tab-a');
      const pageB = await session.getOrCreatePage('group-a', 'tab-b');

      const aClose = deferred<void>();
      (pageA as unknown as { close: () => Promise<void> }).close = vi.fn(() => aClose.promise);

      const closePromise = session.closeGroup('group-a');

      // A client reconnects to the group while tab-a's close is in flight.
      session.incrementGroupClient('group-a');

      aClose.resolve();
      await closePromise;

      expect(pageA.close).toHaveBeenCalled(); // already in flight, completes
      expect((pageB as unknown as { close: () => void }).close).not.toHaveBeenCalled(); // loop aborted
      expect(session.getPage('group-a', 'tab-b')).toBe(pageB);

      // The reconnect's positive count must have survived closeGroup's
      // cleanup: the group must not be swept away immediately even after a
      // full TTL, since clientCount is still positive.
      await vi.advanceTimersByTimeAsync(GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS);
      expect((pageB as unknown as { close: () => void }).close).not.toHaveBeenCalled();
    });
  });
});
