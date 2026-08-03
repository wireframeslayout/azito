import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserSession } from '../BrowserSession';

// BrowserPage.start() opens a real CDPSession, which requires a live browser.
// We stub it out here since this suite only exercises BrowserSession's page
// bookkeeping (reuse-by-id vs. newPage-per-id), not BrowserPage internals
// (covered by BrowserPage.test.ts).
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
    constructor(public rawPage: unknown) {}
  }
  return { ...actual, BrowserPage: MockBrowserPage };
});

describe('BrowserSession.getOrCreatePage', () => {
  let session: BrowserSession;
  let initialPage: { id: string };
  let newPageCallCount: number;

  beforeEach(async () => {
    session = new BrowserSession({ profileDir: '/tmp/test-profile' });
    initialPage = { id: 'initial' };
    newPageCallCount = 0;

    const fakeContext = {
      pages: () => [initialPage],
      newPage: vi.fn(async () => {
        newPageCallCount++;
        return { id: `new-${newPageCallCount}` };
      }),
    };
    (session as unknown as { context: unknown }).context = fakeContext;
    (session as unknown as { _running: boolean })._running = true;
  });

  it('returns the same page instance for the same group/tab id', async () => {
    const page1 = await session.getOrCreatePage('group-a', 'tab-a');
    const page2 = await session.getOrCreatePage('group-a', 'tab-a');
    expect(page1).toBe(page2);
  });

  it('assigns the context initial page to the first requested id', async () => {
    const page = await session.getOrCreatePage('group-a', 'tab-a');
    expect((page as unknown as { rawPage: unknown }).rawPage).toBe(initialPage);
  });

  it('calls context.newPage for a second, distinct id', async () => {
    await session.getOrCreatePage('group-a', 'tab-a');
    const page2 = await session.getOrCreatePage('group-a', 'tab-b');

    expect(newPageCallCount).toBe(1);
    expect((page2 as unknown as { rawPage: unknown }).rawPage).toEqual({ id: 'new-1' });
  });

  it('treats the same tabId in different groups as distinct pages', async () => {
    const pageA = await session.getOrCreatePage('group-a', 'tab-a');
    const pageB = await session.getOrCreatePage('group-b', 'tab-a');

    expect(pageA).not.toBe(pageB);
    expect(newPageCallCount).toBe(1);
  });

  it('dedupes concurrent getOrCreatePage calls for the same id', async () => {
    const [page1, page2] = await Promise.all([
      session.getOrCreatePage('group-a', 'tab-a'),
      session.getOrCreatePage('group-a', 'tab-a'),
    ]);
    expect(page1).toBe(page2);
    expect(newPageCallCount).toBe(0); // reused the context's initial page, no newPage call
  });

  // Regression: two distinct pageIds requested concurrently used to both
  // observe "no page claimed yet" (the reuse check read pageMap.size, which
  // is only populated *after* the awaited page.start()), so both grabbed
  // context.pages()[0] and silently shared one underlying page (one client's
  // navigate leaked into the other's view). The claim must be staked
  // synchronously before any await.
  it('claims the initial page for only one of two concurrently requested distinct ids', async () => {
    const [pageA, pageB] = await Promise.all([
      session.getOrCreatePage('group-a', 'tab-a'),
      session.getOrCreatePage('group-a', 'tab-b'),
    ]);

    expect(pageA).not.toBe(pageB);
    expect(newPageCallCount).toBe(1); // exactly one of the two fell through to newPage()

    const rawPages = [pageA, pageB].map((p) => (p as unknown as { rawPage: unknown }).rawPage);
    expect(rawPages).toContainEqual(initialPage);
    expect(rawPages).toContainEqual({ id: 'new-1' });
  });

  describe('listGroupTabs', () => {
    it('lists only the tabs belonging to the requested group, in creation order', async () => {
      await session.getOrCreatePage('group-a', 'tab-a');
      await session.getOrCreatePage('group-a', 'tab-b');
      await session.getOrCreatePage('group-b', 'tab-a');

      expect(session.listGroupTabs('group-a')).toEqual([
        { tabId: 'tab-a', url: null, loading: false, title: null },
        { tabId: 'tab-b', url: null, loading: false, title: null },
      ]);
      expect(session.listGroupTabs('group-b')).toEqual([
        { tabId: 'tab-a', url: null, loading: false, title: null },
      ]);
      expect(session.listGroupTabs('group-c')).toEqual([]);
    });
  });

  describe('closePage (composite key)', () => {
    it('closes only the page for the given group/tab id, leaving the same tabId in other groups intact', async () => {
      const pageA1 = await session.getOrCreatePage('group-a', 'tab-a');
      const pageB1 = await session.getOrCreatePage('group-b', 'tab-a');

      await session.closePage('group-a', 'tab-a');

      expect((pageA1 as unknown as { close: () => void }).close).toHaveBeenCalled();
      expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
      expect(session.getPage('group-b', 'tab-a')).toBe(pageB1);
      expect((pageB1 as unknown as { close: () => void }).close).not.toHaveBeenCalled();
    });

    it('emits group-tabs-changed for the affected group on close', async () => {
      await session.getOrCreatePage('group-a', 'tab-a');
      const listener = vi.fn();
      session.onGroupTabsChanged(listener);

      await session.closePage('group-a', 'tab-a');

      expect(listener).toHaveBeenCalledWith('group-a');
    });
  });
});
