import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import browserRoutes from '../routes';

// Issue #28 review fix 2: `POST /api/browser/close-group` against an
// `agent`-type server must confirm the remote agent actually closed the
// group (or it was already gone) BEFORE dropping this hub's own
// `browser_groups` ownership row. The original bug swallowed a network
// failure and never checked the HTTP status, then deleted the ownership
// row unconditionally — leaving a still-alive remote group with no
// recorded owner, so the owning task could never close it again (every
// retry would 403 with `operator_required`, since `findOwnerTaskId` returns
// `undefined` once the row is gone).

const mockBrowserSessionManager = {
  closeGroup: vi.fn(async () => {}),
} as never;

const mockServerRepo = {
  findByName: vi.fn(() => ({
    type: 'agent', name: 'remote-agent', host: '10.0.0.1', agentPort: 4000, agentToken: 'tok',
  })),
} as never;

function makeBrowserGroupRepo() {
  return {
    recordOwner: vi.fn(),
    findOwnerTaskId: vi.fn(() => null),
    remove: vi.fn(),
  };
}

describe('POST /api/browser/close-group (agent server path)', () => {
  let app: ReturnType<typeof Fastify>;
  let browserGroupRepo: ReturnType<typeof makeBrowserGroupRepo>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (mockServerRepo as unknown as { findByName: ReturnType<typeof vi.fn> }).findByName.mockReturnValue({
      type: 'agent', name: 'remote-agent', host: '10.0.0.1', agentPort: 4000, agentToken: 'tok',
    });
    browserGroupRepo = makeBrowserGroupRepo();
    app = Fastify();
    app.register(browserRoutes, {
      browserSessionManager: mockBrowserSessionManager,
      serverRepo: mockServerRepo,
      browserGroupRepo: browserGroupRepo as never,
    });
    await app.ready();
  });

  it('drops the ownership row when the agent confirms the group is closed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      payload: { server: 'remote-agent', group: 'agent-deadbeef' },
    });

    expect(res.statusCode).toBe(200);
    expect(browserGroupRepo.remove).toHaveBeenCalledWith('remote-agent', 'agent-deadbeef');
    fetchSpy.mockRestore();
  });

  it('keeps the ownership row and returns 502 when the agent request throws (network failure)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      payload: { server: 'remote-agent', group: 'agent-deadbeef' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('agent_close_group_failed');
    expect(browserGroupRepo.remove).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('keeps the ownership row and returns 502 when the agent responds with a non-2xx status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    } as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      payload: { server: 'remote-agent', group: 'agent-deadbeef' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('agent_close_group_failed');
    expect(browserGroupRepo.remove).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('keeps the ownership row and returns 502 when the agent server is not configured (missing host/port)', async () => {
    (mockServerRepo as unknown as { findByName: ReturnType<typeof vi.fn> }).findByName.mockReturnValue({
      type: 'agent', name: 'remote-agent', host: null, agentPort: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      payload: { server: 'remote-agent', group: 'agent-deadbeef' },
    });

    expect(res.statusCode).toBe(502);
    expect(browserGroupRepo.remove).not.toHaveBeenCalled();
  });
});
