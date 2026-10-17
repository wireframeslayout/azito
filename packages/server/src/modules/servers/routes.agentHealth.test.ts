import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import { KeyedMutex } from '../../shared/keyedMutex';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { AgentTransport } from './transport/AgentTransport';

const agentServer: ServerConfig = {
  name: 'srv7', type: 'agent', host: '10.0.0.7', agentPort: 4021, agentToken: 'tok', agentVersion: null, sshHost: null,
  sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
  isolationCleanupReport: null, defaultMux: 'tmux' as const, muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const refused = (): TypeError => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });

async function buildApp(transport: AgentTransport) {
  const serverRepo = { findByName: vi.fn(() => agentServer), findAll: vi.fn(() => []) } as unknown as IServerRepository;
  const opts: ServersRouteOptions = {
    serverRepo,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    misaoDaemonStatus: vi.fn(async () => ({ installed: false })),
    tmux: {} as ServersRouteOptions['tmux'],
    transportFactory: {
      getTransport: () => transport,
      getAgentTransport: () => transport,
      invalidate: vi.fn(),
    } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry: new MuxDriverRegistry(),
  };
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return app;
}

describe('agent server health routes (circuit breaker)', () => {
  const fetchMock = vi.fn();
  let transport: AgentTransport;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    transport = new AgentTransport('10.0.0.7', 4021, 'tok', 'system', 'srv7');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GET /status reports online with the agent version when reachable', async () => {
    fetchMock.mockImplementation(async (url: string) => (
      String(url).endsWith('/health') ? json({ version: 'abc', pid: 1, uptime: 2 }) : json({ stdout: 'tmux 3.4', stderr: '', code: 0 })
    ));
    const res = await (await buildApp(transport)).inject({ method: 'GET', url: '/api/servers/srv7/status' });
    expect(res.json()).toMatchObject({ status: 'online', mux: { tmux: { available: true, version: 'tmux 3.4' } }, agentVersion: 'abc' });
  });

  it('GET /status reports offline on the first failure, then without touching the network while the breaker is open', async () => {
    fetchMock.mockRejectedValue(refused());
    const app = await buildApp(transport);
    const first = await app.inject({ method: 'GET', url: '/api/servers/srv7/status' });
    expect(first.json()).toMatchObject({ status: 'offline', mux: {}, message: 'Agent unreachable: refused' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await app.inject({ method: 'GET', url: '/api/servers/srv7/status' });
    expect(second.json()).toMatchObject({ status: 'offline', message: 'Agent unreachable: circuit_open' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET /install-status answers 503 offline when uname cannot reach the agent', async () => {
    fetchMock.mockRejectedValue(refused());
    const res = await (await buildApp(transport)).inject({ method: 'GET', url: '/api/servers/srv7/install-status' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'agent_unreachable', server: 'srv7', reason: 'refused', status: 'offline' });
  });

  it('GET /install-status fails fast while the breaker is open', async () => {
    fetchMock.mockRejectedValue(refused());
    const app = await buildApp(transport);
    await app.inject({ method: 'GET', url: '/api/servers/srv7/install-status' });
    fetchMock.mockClear();
    const res = await app.inject({ method: 'GET', url: '/api/servers/srv7/install-status' });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toBe('circuit_open');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
