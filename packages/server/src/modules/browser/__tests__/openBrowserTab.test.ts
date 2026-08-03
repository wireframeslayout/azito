import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openBrowserTab } from '../openBrowserTab';

const mockPage = {
  targetId: 'target-abc123',
  dispatchInput: vi.fn(async () => {}),
};

const mockSession = {
  getOrCreatePage: vi.fn(async () => mockPage),
  setGroupHold: vi.fn(),
};

const mockBrowserSessionManager = {
  getOrCreate: vi.fn(async () => mockSession),
} as never;

describe('openBrowserTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns groupId, tabId, targetId, and cdpEndpoint', async () => {
    const result = await openBrowserTab(mockBrowserSessionManager, 'local', {});

    expect(result.groupId).toMatch(/^agent-[a-f0-9]{8}$/);
    expect(result.tabId).toBe('t1');
    expect(result.targetId).toBe('target-abc123');
    expect(result.cdpEndpoint).toBe('http://127.0.0.1:9222');
  });

  it('passes hubOrigin to getOrCreate', async () => {
    await openBrowserTab(mockBrowserSessionManager, 'local', { hubOrigin: 'http://localhost:3001' });

    expect((mockBrowserSessionManager as unknown as { getOrCreate: ReturnType<typeof vi.fn> }).getOrCreate)
      .toHaveBeenCalledWith('local', { hubOrigin: 'http://localhost:3001' });
  });

  it('navigates when url is provided', async () => {
    await openBrowserTab(mockBrowserSessionManager, 'local', { url: 'https://example.com' });

    expect(mockPage.dispatchInput).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com' });
  });

  it('does not navigate when url is omitted', async () => {
    await openBrowserTab(mockBrowserSessionManager, 'local', {});

    expect(mockPage.dispatchInput).not.toHaveBeenCalled();
  });

  it('sets group hold when holdSeconds is provided', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await openBrowserTab(mockBrowserSessionManager, 'local', { holdSeconds: 300 });

    expect(mockSession.setGroupHold).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-/),
      now + 300 * 1000,
    );

    vi.spyOn(Date, 'now').mockRestore();
  });

  it('clamps holdSeconds to 3600', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await openBrowserTab(mockBrowserSessionManager, 'local', { holdSeconds: 9999 });

    expect(mockSession.setGroupHold).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-/),
      now + 3600 * 1000,
    );

    vi.spyOn(Date, 'now').mockRestore();
  });

  it('does not set hold when holdSeconds is 0', async () => {
    await openBrowserTab(mockBrowserSessionManager, 'local', { holdSeconds: 0 });

    expect(mockSession.setGroupHold).not.toHaveBeenCalled();
  });
});
