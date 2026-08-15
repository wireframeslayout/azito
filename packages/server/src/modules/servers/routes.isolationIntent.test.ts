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

  // Issue #29 review, Important finding 1: switching an isolated agent
  // server's type to 'local' must not strand isolation_intent=1 on the row —
  // TaskPaneEnvironmentService/HarnessInstaller only ever gate on
  // "agent-type or not", so a stranded intent on a local row is dead state
  // that also blocks a later re-declaration attempt from being visible as a
  // real change.
  describe('isolation_intent auto-clear on type -> local (Issue #29 Important finding 1)', () => {
    it('auto-clears isolation_intent when type changes to local, even without isolationIntent in the request body', async () => {
      const opts = makeOpts();
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: true }));
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'local' } });

      expect(res.statusCode).toBe(200);
      expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', false);
    });

    it('accepts isolationIntent: false alongside type: local (previously rejected as 400)', async () => {
      const opts = makeOpts();
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: true }));
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'local', isolationIntent: false } });

      expect(res.statusCode).toBe(200);
      expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', false);
    });

    it('still rejects isolationIntent: true alongside type: local', async () => {
      const opts = makeOpts();
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'local', isolationIntent: true } });

      expect(res.statusCode).toBe(400);
      expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
    });

    it('does not call updateIsolationIntent when switching to local and the row was never isolated', async () => {
      const opts = makeOpts();
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { type: 'local' } });

      expect(res.statusCode).toBe(200);
      expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
    });
  });

  // Issue #29 review, Important finding 2: isolationIntent must be validated
  // as an actual boolean at the API boundary — truthiness alone would
  // persist a string like "false" as `true`.
  describe('isolationIntent runtime type validation (Issue #29 Important finding 2)', () => {
    it.each([
      ['the string "false"', 'false'],
      ['the string "true"', 'true'],
      ['a number', 1],
      ['null', null],
      ['an object', {}],
      ['an array', []],
    ])('rejects isolationIntent when it is %s (not a real boolean)', async (_label, value) => {
      const opts = makeOpts();
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent' }));
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: value } });

      expect(res.statusCode).toBe(400);
      expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
    });
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
