import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserSession } from '../BrowserSession';

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

describe('BrowserSession group hold', () => {
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
    (session as unknown as { sweepTimer: unknown }).sweepTimer = setInterval(
      () => (session as unknown as { sweepIdleGroups: () => void }).sweepIdleGroups(),
      GROUP_SWEEP_INTERVAL_MS,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not sweep a group that is within its hold period', async () => {
    const page = await session.getOrCreatePage('group-a', 'tab-a');
    session.decrementGroupClient('group-a');
    session.setGroupHold('group-a', Date.now() + GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS + 60_000);

    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS);

    expect(page.close).not.toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-a')).toBe(page);
  });

  it('sweeps a group after hold expires and GROUP_TTL elapses', async () => {
    const page = await session.getOrCreatePage('group-a', 'tab-a');
    session.decrementGroupClient('group-a');
    session.setGroupHold('group-a', Date.now() + 30_000);

    // Hold expires at +30s, then GROUP_TTL (5m) must also elapse
    await vi.advanceTimersByTimeAsync(30_000 + GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS);

    expect(page.close).toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
  });

  it('does not sweep after hold expires if GROUP_TTL has not elapsed from lastSeen', async () => {
    const page = await session.getOrCreatePage('group-a', 'tab-a');
    session.decrementGroupClient('group-a');
    session.setGroupHold('group-a', Date.now() + 30_000);

    // Advance past hold expiry but not past GROUP_TTL from creation time
    await vi.advanceTimersByTimeAsync(30_000 + GROUP_SWEEP_INTERVAL_MS);

    expect(page.close).not.toHaveBeenCalled();
    expect(session.getPage('group-a', 'tab-a')).toBe(page);
  });

  it('closeGroup clears the hold', async () => {
    await session.getOrCreatePage('group-a', 'tab-a');
    session.setGroupHold('group-a', Date.now() + 600_000);

    await session.closeGroup('group-a');

    expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
    // Hold should be cleared — verify by creating a new page and checking it can be swept normally
    const page2 = await session.getOrCreatePage('group-a', 'tab-b');
    session.decrementGroupClient('group-a');
    await vi.advanceTimersByTimeAsync(GROUP_TTL_MS + GROUP_SWEEP_INTERVAL_MS);
    expect(page2.close).toHaveBeenCalled();
  });

  it('stop clears all holds', async () => {
    await session.getOrCreatePage('group-a', 'tab-a');
    session.setGroupHold('group-a', Date.now() + 600_000);
    await session.stop();

    expect(session.getPage('group-a', 'tab-a')).toBeUndefined();
  });
});
