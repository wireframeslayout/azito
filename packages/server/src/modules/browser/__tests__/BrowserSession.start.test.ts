import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserSession, buildDefaultUserAgent } from '../BrowserSession';

const mockLaunchPersistentContext = vi.fn();

vi.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: (...args: unknown[]) => mockLaunchPersistentContext(...args),
  },
}));

vi.mock('../BrowserPage', async () => {
  const actual = await vi.importActual('../BrowserPage');
  class MockBrowserPage {
    start = vi.fn(async () => {});
    close = vi.fn(async () => {});
    onUrl = vi.fn(() => () => {});
    onLoading = vi.fn(() => () => {});
    onTitle = vi.fn(() => () => {});
    constructor(public rawPage: unknown) {}
  }
  return { ...actual, BrowserPage: MockBrowserPage };
});

describe('BrowserSession.start – userAgent option', () => {
  beforeEach(() => {
    mockLaunchPersistentContext.mockReset();
    mockLaunchPersistentContext.mockResolvedValue({
      pages: () => [],
      newPage: vi.fn(async () => ({})),
      close: vi.fn(async () => {}),
    });
    delete process.env.AZITO_BROWSER_UA;
  });

  afterEach(() => {
    delete process.env.AZITO_BROWSER_UA;
  });

  it('passes the default userAgent to launchPersistentContext', async () => {
    const session = new BrowserSession({ profileDir: '/tmp/test-profile' });
    await session.start();

    expect(mockLaunchPersistentContext).toHaveBeenCalledOnce();
    const opts = mockLaunchPersistentContext.mock.calls[0][1];
    expect(opts.userAgent).toBe(buildDefaultUserAgent());
    expect(opts.userAgent).toContain('Chrome/');
    expect(opts.userAgent).not.toContain('HeadlessChrome');

    await session.stop();
  });

  it('uses AZITO_BROWSER_UA when set', async () => {
    process.env.AZITO_BROWSER_UA = 'Custom-Agent/1.0';
    const session = new BrowserSession({ profileDir: '/tmp/test-profile' });
    await session.start();

    const opts = mockLaunchPersistentContext.mock.calls[0][1];
    expect(opts.userAgent).toBe('Custom-Agent/1.0');

    await session.stop();
  });

  it('preserves other launch options alongside userAgent', async () => {
    const session = new BrowserSession({ profileDir: '/tmp/test-profile', headful: true, hubOrigin: 'http://localhost:3001' });
    await session.start();

    const [profileDir, opts] = mockLaunchPersistentContext.mock.calls[0];
    expect(profileDir).toBe('/tmp/test-profile');
    expect(opts.headless).toBe(false);
    expect(opts.ignoreDefaultArgs).toEqual(['--enable-automation']);
    expect(opts.args).toContain('--disable-blink-features=AutomationControlled');
    expect(opts.args).toContain('--remote-allow-origins=http://localhost:3001');
    expect(opts.userAgent).toBeDefined();

    await session.stop();
  });

  it('sets ignoreHTTPSErrors to true for self-signed certificates', async () => {
    const session = new BrowserSession({ profileDir: '/tmp/test-profile' });
    await session.start();

    const opts = mockLaunchPersistentContext.mock.calls[0][1];
    expect(opts.ignoreHTTPSErrors).toBe(true);

    await session.stop();
  });
});
