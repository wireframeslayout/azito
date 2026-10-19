import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import { KeyedMutex } from '../../shared/keyedMutex';

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'local',
    type: 'local',
    host: null,
    agentPort: null,
    agentToken: null,
    agentVersion: null,
    sshHost: null,
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null,
    isolationCleanupReport: null,
    defaultMux: 'tmux' as const, muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(servers: ServerConfig[] = []): ServersRouteOptions {
  const serverRepo: IServerRepository = {
    findAll: vi.fn(() => servers),
    findByName: vi.fn((name: string) => servers.find((s) => s.name === name)),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    updateFingerprint: vi.fn(),
    clearFingerprint: vi.fn(),
    updateIsolationIntent: vi.fn(),
    findMetaByNames: vi.fn(() => []),
    updateIsolationReport: vi.fn(),
    updateIsolationCleanupReport: vi.fn(),
    updateIsolationVerification: vi.fn(),
    updateIsolationFailure: vi.fn(),
    delete: vi.fn(),
  } as unknown as IServerRepository;
  return {
    serverRepo,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    misaoDaemonStatus: vi.fn(async () => ({ installed: false })),
    tmux: { listSessionsForSecurityGate: vi.fn(async () => []) } as unknown as ServersRouteOptions['tmux'],
    transportFactory: { invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    harnessHash: 'testhash',
    harnessUpdater: { getLastResult: vi.fn() } as unknown as ServersRouteOptions['harnessUpdater'],
    scopedAuthEnabled: true,
    muxDriverRegistry: { resolve: vi.fn(() => ({ caps: { changeEvents: true, agentState: false, independentClients: true, copyMode: true } })), has: vi.fn(() => true), register: vi.fn() } as unknown as ServersRouteOptions['muxDriverRegistry'],
    repoDiscovery: {
      checkPathStatus: vi.fn(async () => ({ exists: true, isGitRepository: false })),
      discover: vi.fn(async () => []),
    } as unknown as ServersRouteOptions['repoDiscovery'],
  };
}

async function buildApp(opts: ServersRouteOptions) {
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return app;
}

describe('POST /api/servers — local server duplicate rejection', () => {
  it('rejects a second local server with 409 local_server_exists', async () => {
    const existing = makeServer({ name: 'existing-local', type: 'local' });
    const app = await buildApp(makeOpts([existing]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: { name: 'new-local', type: 'local' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('local_server_exists');
    await app.close();
  });

  it('allows an agent server when a local server exists', async () => {
    const existing = makeServer({ name: 'existing-local', type: 'local' });
    const app = await buildApp(makeOpts([existing]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: { name: 'agent1', type: 'agent', host: '1.2.3.4', agentPort: 3001, agentToken: 'tok' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });
});
