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
    updateIsolationReport: vi.fn(),
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

// Issue #29 review, Important finding 1: false->true must trigger a
// synchronous remote cleanup (withholds --ui-token, forces
// --purge-operator-token via HarnessInstaller), and record its outcome in
// isolation_report — never silently leave a stale credential on a server now
// labeled "isolated".
describe('PUT /api/servers/:name — isolation cleanup on false->true (Issue #29 Important finding 1)', () => {
  function makeHarnessInstaller(installImpl: ReturnType<typeof vi.fn>) {
    return { install: installImpl, installLocal: vi.fn() } as unknown as ServersRouteOptions['harnessInstaller'];
  }

  it('calls harnessInstaller.install with isolationIntent:true and records a "done" report on success', async () => {
    const install = vi.fn(async () => ({ success: true, steps: [] }));
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(install).toHaveBeenCalledWith(
      'user@host',
      expect.objectContaining({ isolationIntent: true }),
    );
    expect(opts.serverRepo.updateIsolationReport).toHaveBeenCalledWith(
      'srv',
      expect.stringContaining('"cleanup":"done"'),
    );
  });

  it('records a "failed" report (without failing the request) when the installer reports failure', async () => {
    const install = vi.fn(async () => ({ success: false, steps: [], error: 'ssh unreachable' }));
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationReport).toHaveBeenCalledWith(
      'srv',
      expect.stringContaining('"cleanup":"failed"'),
    );
    const [, reportJson] = (opts.serverRepo.updateIsolationReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(reportJson).error).toBe('ssh unreachable');
  });

  it('records a "failed" report when the installer throws', async () => {
    const install = vi.fn(async () => { throw new Error('boom'); });
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    const [, reportJson] = (opts.serverRepo.updateIsolationReport as ReturnType<typeof vi.fn>).mock.calls[0];
    const report = JSON.parse(reportJson);
    expect(report.cleanup).toBe('failed');
    expect(report.error).toBe('boom');
  });

  it('records a "skipped" report (no installer call, no PUT failure) when unreachable — no sshHost/host', async () => {
    const install = vi.fn();
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: null, host: null }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(install).not.toHaveBeenCalled();
    const [, reportJson] = (opts.serverRepo.updateIsolationReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(reportJson).cleanup).toBe('skipped');
  });

  it('does not attempt cleanup when isolationIntent was already true (no-op transition)', async () => {
    const install = vi.fn(async () => ({ success: true, steps: [] }));
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(install).not.toHaveBeenCalled();
    expect(opts.serverRepo.updateIsolationReport).not.toHaveBeenCalled();
  });

  // Issue #29 review (3rd pass), Important finding 2: updateIsolationIntent()
  // unconditionally clears isolation_verified_at/isolation_report as part of
  // its own UPDATE (see SqliteServerRepository) — a no-op true->true (or
  // false->false) PUT must not call it at all, or an existing report
  // silently disappears with no cleanup retry to regenerate it.
  it('does not call updateIsolationIntent on a no-op true->true PUT (preserves any existing report)', async () => {
    const install = vi.fn(async () => ({ success: true, steps: [] }));
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationReport: '{"cleanup":"done"}' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('does not call updateIsolationIntent on a no-op false->false PUT', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: false } });

    expect(res.statusCode).toBe(200);
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

// Issue #29 review, Important finding 2: cleanup outcome must be visible via
// the API — previously it was recorded only in isolation_report, a field the
// list endpoint deliberately excludes and no detail route ever returned.
describe('GET /api/servers/:name — isolationReport detail route (Issue #29 Important finding 2)', () => {
  it('returns the full server config including isolationReport', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ isolationIntent: true, isolationVerifiedAt: null, isolationReport: '{"kind":"cleanup","cleanup":"failed","error":"ssh unreachable"}' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/srv' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.isolationIntent).toBe(true);
    expect(JSON.parse(body.isolationReport).cleanup).toBe('failed');
    expect(body.agentToken).toBeUndefined();
    expect(body.hasAgentToken).toBe(true);
  });

  it('404s for an unknown server', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/missing' });

    expect(res.statusCode).toBe(404);
  });
});

// Issue #29 review, Important finding 2: the PUT response itself must carry
// the cleanup outcome — an operator declaring isolation should not have to
// make a second request to learn whether a stale token was actually purged.
describe('PUT /api/servers/:name — isolationCleanup in the response (Issue #29 Important finding 2)', () => {
  function makeHarnessInstaller(installImpl: ReturnType<typeof vi.fn>) {
    return { install: installImpl, installLocal: vi.fn() } as unknown as ServersRouteOptions['harnessInstaller'];
  }

  it('includes isolationCleanup: "done" when cleanup succeeds', async () => {
    const install = vi.fn(async () => ({ success: true, steps: [] }));
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.json().isolationCleanup).toBe('done');
  });

  it('includes isolationCleanup: "failed" when cleanup fails, without failing the request', async () => {
    const install = vi.fn(async () => ({ success: false, steps: [], error: 'ssh unreachable' }));
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(res.json().isolationCleanup).toBe('failed');
  });

  it('omits isolationCleanup when no cleanup was attempted (plain host update)', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent' }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { host: '5.6.7.8' } });

    expect(res.json().isolationCleanup).toBeUndefined();
  });
});
