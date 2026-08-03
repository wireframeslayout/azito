import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import browserRoutes from '../routes';

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
  getStatus: vi.fn(() => ({ running: false, clientCount: 0, pages: [] })),
  stop: vi.fn(async () => {}),
  keepalive: vi.fn(),
  closeGroup: vi.fn(async () => {}),
} as never;

const mockServerRepo = {
  findByName: vi.fn(() => ({ type: 'local', name: 'local' })),
} as never;

describe('POST /api/browser/open', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.register(browserRoutes, {
      browserSessionManager: mockBrowserSessionManager,
      serverRepo: mockServerRepo,
    });
    await app.ready();
  });

  it('returns groupId, tabId, targetId, and cdpEndpoint on success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'local' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupId).toMatch(/^agent-[a-f0-9]{8}$/);
    expect(body.tabId).toBe('t1');
    expect(body.targetId).toBe('target-abc123');
    expect(body.cdpEndpoint).toBe('http://127.0.0.1:9222');
  });

  it('navigates to the given url', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'local', url: 'https://example.com' },
    });

    expect(mockPage.dispatchInput).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com' });
  });

  it('does not navigate when url is omitted', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'local' },
    });

    expect(mockPage.dispatchInput).not.toHaveBeenCalled();
  });

  it('sets group hold when holdSeconds is provided', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'local', holdSeconds: 300 },
    });

    expect(mockSession.setGroupHold).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-/),
      now + 300 * 1000,
    );

    vi.spyOn(Date, 'now').mockRestore();
  });

  it('clamps holdSeconds to 3600', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'local', holdSeconds: 9999 },
    });

    expect(mockSession.setGroupHold).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-/),
      now + 3600 * 1000,
    );

    vi.spyOn(Date, 'now').mockRestore();
  });

  it('does not set hold when holdSeconds is 0', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'local', holdSeconds: 0 },
    });

    expect(mockSession.setGroupHold).not.toHaveBeenCalled();
  });

  it('returns 400 when server is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('server is required');
  });

  it('forwards to agent server and returns its response', async () => {
    const agentResponse = { groupId: 'agent-deadbeef', tabId: 't1', targetId: 'target-remote', cdpEndpoint: 'http://127.0.0.1:9222' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => agentResponse,
    } as Response);

    (mockServerRepo as unknown as { findByName: ReturnType<typeof vi.fn> }).findByName.mockReturnValueOnce({
      type: 'agent', host: '10.0.0.1', agentPort: 4000, agentToken: 'tok123',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'remote-agent', url: 'https://example.com', holdSeconds: 60 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(agentResponse);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://10.0.0.1:4000/api/browser/open',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer tok123' }),
        body: JSON.stringify({ url: 'https://example.com', holdSeconds: 60 }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it('returns 400 when agent server is not configured', async () => {
    (mockServerRepo as unknown as { findByName: ReturnType<typeof vi.fn> }).findByName.mockReturnValueOnce({
      type: 'agent', host: null, agentPort: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'remote-agent' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('agent server not configured');
  });

  it('forwards agent error status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'browser launch failed' }),
    } as Response);

    (mockServerRepo as unknown as { findByName: ReturnType<typeof vi.fn> }).findByName.mockReturnValueOnce({
      type: 'agent', host: '10.0.0.1', agentPort: 4000, agentToken: 'tok',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'remote-agent' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('browser launch failed');

    fetchSpy.mockRestore();
  });

  it('returns 404 when server does not exist', async () => {
    (mockServerRepo as unknown as { findByName: ReturnType<typeof vi.fn> })
      .findByName.mockReturnValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      payload: { server: 'nonexistent' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Server not found: nonexistent');
    expect((mockBrowserSessionManager as unknown as { getOrCreate: ReturnType<typeof vi.fn> }).getOrCreate).not.toHaveBeenCalled();
  });
});
