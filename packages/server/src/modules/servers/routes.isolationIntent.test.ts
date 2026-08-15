import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import { KeyedMutex } from '../../shared/keyedMutex';

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
    // Issue #29 review (5th pass), Critical finding 1: the false->true gate
    // now also checks for live tmux sessions on the target server —
    // listSessions() defaults to an empty array so every existing test not
    // about that specific check stays a no-op through it.
    tmux: { listSessions: vi.fn(async () => []) } as unknown as ServersRouteOptions['tmux'],
    transportFactory: { invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    // Issue #29 review, Critical finding 1: no windows registered by
    // default, so the false->true gate is a no-op unless a test overrides
    // findByServer to return risky rows.
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    // Issue #29 review (6th pass), Important finding 3: a fresh instance per
    // test is fine here (this file never exercises cross-route serialization
    // against sessions.ts — that's covered by sessions.test.ts's own
    // instance plus the shared-wiring assertion in buildServer.ts).
    serverIsolationMutex: new KeyedMutex(),
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

  // Issue #29 review (final pass), Important finding 2: a true->true PUT is
  // NOT a full no-op anymore — a stuck 'pending'/'failed'/missing report
  // (crash between the intent commit and the cleanup write, or a genuine
  // prior failure) is retried, because nothing else in this system would
  // ever prompt a retry otherwise. Only a report that already settled at
  // 'done' stays untouched (covered separately below).
  describe('true->true retries a not-yet-done cleanup outcome (Issue #29 review, final pass, Important finding 2)', () => {
    it('retries when isolationReport is null (e.g. a pre-fix row, or startup recovery has not run yet)', async () => {
      const install = vi.fn(async () => ({ success: true, steps: [] }));
      const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationReport: null }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).toHaveBeenCalledTimes(1);
      expect(res.json().isolationCleanup).toBe('done');
      // Retrying must not re-flip isolation_intent (it was already true) —
      // only attemptIsolationCleanup's own updateIsolationReport() write runs.
      expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
    });

    it('retries when isolationReport.cleanup is "pending" (the atomic marker written by the original false->true flip)', async () => {
      const install = vi.fn(async () => ({ success: true, steps: [] }));
      const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationReport: JSON.stringify({ kind: 'cleanup', cleanup: 'pending' }) }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).toHaveBeenCalledTimes(1);
    });

    it('retries when isolationReport.cleanup is "failed"', async () => {
      const install = vi.fn(async () => ({ success: true, steps: [] }));
      const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationReport: JSON.stringify({ kind: 'cleanup', cleanup: 'failed', error: 'boom' }) }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry when isolationReport.cleanup is already "done" — stays a complete no-op', async () => {
      const install = vi.fn(async () => ({ success: true, steps: [] }));
      const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).not.toHaveBeenCalled();
      expect(opts.serverRepo.updateIsolationReport).not.toHaveBeenCalled();
      expect(res.json().isolationCleanup).toBeUndefined();
    });
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
      makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationReport: '{"kind":"cleanup","cleanup":"done"}' }),
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

// Issue #29 review, Critical finding 1: a false->true isolation_intent
// transition must be rejected (fail closed) when a window that may already
// hold injected credentials is registered on the target server — the old
// behavior only purged the persisted operator-token config and left any
// already-running pane's environment untouched.
describe('isolation_intent false->true window-presence gate (Issue #29 review, Critical finding 1)', () => {
  it('rejects with 409 when an agent-type window is registered on the server', async () => {
    const findByServer = vi.fn(() => [
      { id: 1, windowType: 'agent', taskId: null } as unknown as ReturnType<NonNullable<ServersRouteOptions['windowRepo']>['findByServer']>[number],
    ]);
    const opts = makeOpts({ windowRepo: { findByServer } as unknown as ServersRouteOptions['windowRepo'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('isolation_intent_blocked_by_windows');
    expect(res.json().windowCount).toBe(1);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
    expect(findByServer).toHaveBeenCalledWith('srv');
  });

  it('rejects with 409 when a task-owned (non-agent windowType) window is registered', async () => {
    const findByServer = vi.fn(() => [
      { id: 2, windowType: 'terminal', taskId: 42 } as unknown as ReturnType<NonNullable<ServersRouteOptions['windowRepo']>['findByServer']>[number],
    ]);
    const opts = makeOpts({ windowRepo: { findByServer } as unknown as ServersRouteOptions['windowRepo'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('allows the transition when only plain terminal, non-task windows are registered', async () => {
    const findByServer = vi.fn(() => [
      { id: 3, windowType: 'terminal', taskId: null } as unknown as ReturnType<NonNullable<ServersRouteOptions['windowRepo']>['findByServer']>[number],
    ]);
    const opts = makeOpts({ windowRepo: { findByServer } as unknown as ServersRouteOptions['windowRepo'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });

  it('does not gate a true->true no-op PUT (no new transition)', async () => {
    const findByServer = vi.fn(() => [
      { id: 1, windowType: 'agent', taskId: null } as unknown as ReturnType<NonNullable<ServersRouteOptions['windowRepo']>['findByServer']>[number],
    ]);
    const opts = makeOpts({ windowRepo: { findByServer } as unknown as ServersRouteOptions['windowRepo'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: true }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('does not gate a false->true transition when the server has no registered windows at all', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });
});

// Issue #29 review (5th pass), Critical finding 1: the `windows` DB table
// only covers windows AZITO itself created and is still tracking — it says
// nothing about a session created directly on the server (e.g. via the
// generic manual tmux session/window/pane routes, which before this same
// review round's fix could inject AZITO_UI_TOKEN with no corresponding
// `windows` row at all). A live tmux session is an INDEPENDENT signal,
// checked in addition to the windowRepo check above, not instead of it.
describe('isolation_intent false->true live-tmux-session gate (Issue #29 review, 5th pass, Critical finding 1)', () => {
  it('rejects with 409 when the server has a live tmux session, even with no registered windows', async () => {
    const opts = makeOpts({
      tmux: { listSessions: vi.fn(async () => [{ name: 'manual-session', windowCount: 1, attached: false, created: 0, windows: [] }]) } as unknown as ServersRouteOptions['tmux'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('isolation_intent_blocked_by_live_sessions');
    expect(res.json().sessionCount).toBe(1);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('fails closed (409) when listing live tmux sessions throws', async () => {
    const opts = makeOpts({
      tmux: { listSessions: vi.fn(async () => { throw new Error('ssh unreachable'); }) } as unknown as ServersRouteOptions['tmux'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('isolation_intent_blocked_by_session_check_failure');
    expect(res.json().message).toContain('ssh unreachable');
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('allows the transition when there are no registered windows and no live tmux sessions', async () => {
    const opts = makeOpts({
      tmux: { listSessions: vi.fn(async () => []) } as unknown as ServersRouteOptions['tmux'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });

  it('does not check live sessions on a true->true no-op PUT', async () => {
    const listSessions = vi.fn(async () => []);
    const opts = makeOpts({ tmux: { listSessions } as unknown as ServersRouteOptions['tmux'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: true }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(listSessions).not.toHaveBeenCalled();
  });
});

// Issue #29 review (6th pass), Important finding 2: a false->true transition
// combined with a connection-info change in the SAME PUT must be rejected —
// the risky-window/live-session checks inspect the OLD connection (`srv`,
// fetched before this request's own update), while attemptIsolationCleanup
// re-fetches the row AFTER the update and purges against the NEW connection.
// Accepting both at once would check one endpoint and clean up a different
// one.
describe('isolation_intent blocks a simultaneous connection-info change (Issue #29 review, 6th/8th pass)', () => {
  it('rejects with 400 when host changes alongside isolationIntent: false->true', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { host: '9.9.9.9', isolationIntent: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('rejects with 400 when sshHost changes alongside isolationIntent: false->true', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@old-host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { sshHost: 'user@new-host', isolationIntent: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('rejects with 400 when agentPort or agentToken changes alongside isolationIntent: false->true', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, agentPort: 4000, agentToken: 'old-tok' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { agentToken: 'new-tok', isolationIntent: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('allows isolationIntent: false->true alone (no connection-info field in the body)', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });

  it('allows a connection-info change resubmitted with the SAME value (no actual change) alongside isolationIntent: false->true', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { host: '1.2.3.4', isolationIntent: true },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });

  // Issue #29 review (7th pass), Important finding 2: `type` (local->agent)
  // and `muxRuntime` (system->managed) changes are just as much an "endpoint
  // the check/cleanup could disagree about" as host/sshHost/agentPort/
  // agentToken — missing them let a false->true transition slip past this
  // guard while switching the very endpoint the risky-window/live-session
  // checks and the cleanup purge are each looking at.
  it('rejects with 400 when type changes from local to agent alongside isolationIntent: false->true', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'local', isolationIntent: false }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { type: 'agent', isolationIntent: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('rejects with 400 when muxRuntime changes alongside isolationIntent: false->true', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, muxRuntime: 'system' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { muxRuntime: 'managed', isolationIntent: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  // Issue #29 review (8th pass), Critical finding 1: a true->true PUT used
  // to be treated as "not a new transition" and therefore exempt from this
  // gate — but the server is STILL isolated throughout, so a connection
  // change here has exactly the same "cleanup report describes the wrong
  // endpoint" problem as the false->true case above. Reversed from the old
  // "allows" expectation.
  it('rejects with 400 when a connection-info change accompanies a true->true no-op (server stays isolated)', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { host: '9.9.9.9', isolationIntent: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });

  // Issue #29 review (8th pass), Critical finding 1: the actual gap the
  // finding describes — an already-isolated server (isolationIntent: true
  // persisted) receiving a PUT that doesn't mention isolationIntent at all.
  // The old check only looked at `isolationIntent === true && isolationIntent
  // !== srv.isolationIntent`, so an omitted field (undefined !== true is
  // false... but the old condition required isolationIntent === true
  // explicitly) never entered the gate, letting host/sshHost/agentPort/
  // agentToken/type/muxRuntime change freely on an isolated row.
  it('rejects with 400 when host changes and isolationIntent is omitted entirely from an already-isolated server', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { host: '9.9.9.9' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  // The escape hatch: explicitly disabling isolation in the same request is
  // the one combination that must still be accepted, matching the message
  // ("disable isolation first, then change the connection") — this proves
  // the gate is driven by the EFFECTIVE end-state intent, not merely
  // "isolationIntent field present and true".
  it('allows a connection-info change alongside an explicit isolationIntent: true->false in the same request', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { host: '9.9.9.9', isolationIntent: false },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.update).toHaveBeenCalled();
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', false);
  });
});
