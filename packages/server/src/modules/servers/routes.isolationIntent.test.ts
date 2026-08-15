import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';

// Issue #29 Step 1: isolation_intent is only settable for agent servers — a
// local server always shares the hub process's own credential store, so
// declaring it "isolated" would be a lie the credential-distribution gates
// (TaskPaneEnvironmentService, HarnessInstaller) could never honor.

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'srv',
    type: 'agent',
    host: '1.2.3.4',
    agentPort: 4000,
    agentToken: 'tok',
    agentVersion: '1.0.0',
    sshHost: null,
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null,
    muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(overrides: Partial<ServersRouteOptions> = {}): ServersRouteOptions {
  const serverRepo: IServerRepository = {
    findAll: vi.fn(() => []),
    findByName: vi.fn(() => makeServer()),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    updateFingerprint: vi.fn(),
    clearFingerprint: vi.fn(),
    updateIsolationIntent: vi.fn(),
    delete: vi.fn(),
  };
  return {
    serverRepo,
    tmux: {} as ServersRouteOptions['tmux'],
    transportFactory: { invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    webhookToken: 'wh',
    uiToken: 'ui',
    ...overrides,
  };
}

async function buildApp(opts: ServersRouteOptions) {
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return app;
}

describe('PUT /api/servers/:name — isolationIntent (Issue #29 Step 1)', () => {
  it('rejects isolationIntent for a local server (400)', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'local' }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(400);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('accepts isolationIntent for an agent server and persists it', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent' }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });

  it('does not touch isolationIntent when the field is omitted from the PUT body', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent' }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { host: '5.6.7.8' } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('rejects isolationIntent when a request also sets type to "local" on an existing agent row', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent' }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'local', isolationIntent: true } });

    expect(res.statusCode).toBe(400);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });
});

describe('GET /api/servers — isolationReport exclusion', () => {
  it('exposes isolationIntent/isolationVerifiedAt but not isolationReport', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findAll as ReturnType<typeof vi.fn>).mockReturnValue([
      makeServer({ isolationIntent: true, isolationVerifiedAt: '2026-08-15T00:00:00Z', isolationReport: '{"findings":[]}' }),
    ]);
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers' });
    const body = res.json();

    expect(body[0].isolationIntent).toBe(true);
    expect(body[0].isolationVerifiedAt).toBe('2026-08-15T00:00:00Z');
    expect(body[0].isolationReport).toBeUndefined();
  });
});
