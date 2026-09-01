import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import { KeyedMutex } from '../../shared/keyedMutex';

// Review round (isolation doctor, Critical finding 1 / review round Important
// finding 2): the FS-boundary check reads a canary via
// getVerifiedHubCanary() (hubCanary.ts) — a real hub process writes this at
// startup and re-verifies it on disk before each doctor run, but this test
// process never does either. Mocked with a fixed, known canary so the doctor
// tests below can control whether it reads back as present/absent, exactly
// like every other fake `exec` response in this file.
//
// same_host judgment restructure: `checkFsAndHostBoundary` also calls
// `isCanaryStillIntact()` right after a remote 'absent' answer, to guard
// against a rotation race — mocked to always report intact (`true`) here
// since this fixed canary is never actually rewritten during a test run.
vi.mock('./hubCanary', () => ({
  getVerifiedHubCanary: () => ({ path: '/hub/data/.azito-hub-canary-test', content: 'test-canary-content' }),
  isCanaryStillIntact: () => true,
}));

// Security fix (same_host boot_id-based detection): routes.ts reads the
// hub's own boot_id straight off the real host running this test process
// (readHubBootId(), a plain `fs.readFileSync`, is not mocked). Every fake
// `exec` handler below that wants `same_host` to resolve to 'pass' must
// answer the boot_id probe with SOME syntactically valid, differing value
// (the exact value doesn't matter — it only needs to not collide with
// whatever the real test host's boot_id happens to be) rather than leaving
// it unanswered (which falls through to the never-'pass' hostname/uid
// fallback).
function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}
const FAKE_REMOTE_BOOT_ID_RESPONSE = {
  stdout: `AZT_STATUS:f:present\n${b64('99999999-9999-9999-9999-999999999999')}\nAZT_STATUS_END:f\n`,
  stderr: '',
  code: 0,
};

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
    isolationCleanupReport: null,
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
    findMetaByNames: vi.fn(() => []),
    updateIsolationReport: vi.fn(),
    updateIsolationCleanupReport: vi.fn(),
    updateIsolationVerification: vi.fn(),
    updateIsolationFailure: vi.fn(),
    delete: vi.fn(),
  };
  return {
    serverRepo,
    // Issue #29 review (5th pass), Critical finding 1: the false->true gate
    // now also checks for live tmux sessions on the target server —
    // listSessionsForSecurityGate() defaults to an empty array so every
    // existing test not about that specific check stays a no-op through it.
    // Issue #29 review (7th pass), Critical finding 1: the gate uses the
    // security-gate-specific method, not the display-oriented listSessions().
    tmux: { listSessionsForSecurityGate: vi.fn(async () => []) } as unknown as ServersRouteOptions['tmux'],
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
    // Issue #29 Step 2 C-1: defaults to true (scoped auth already enabled)
    // so every pre-existing test in this file — none of which are about the
    // C-1 gate itself — keeps exercising the false->true/true->true
    // isolation flow unchanged. The dedicated C-1 describe block below
    // overrides this to false per-test.
    scopedAuthEnabled: true,
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
    expect(opts.serverRepo.updateIsolationCleanupReport).toHaveBeenCalledWith(
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
    expect(opts.serverRepo.updateIsolationCleanupReport).toHaveBeenCalledWith(
      'srv',
      expect.stringContaining('"cleanup":"failed"'),
    );
    const [, reportJson] = (opts.serverRepo.updateIsolationCleanupReport as ReturnType<typeof vi.fn>).mock.calls[0];
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
    const [, reportJson] = (opts.serverRepo.updateIsolationCleanupReport as ReturnType<typeof vi.fn>).mock.calls[0];
    const report = JSON.parse(reportJson);
    expect(report.cleanup).toBe('failed');
    expect(report.error).toBe('boom');
  });

  it('redacts a plaintext token embedded in the installer error message before persisting the report (independent QC review, I-1)', async () => {
    // Simulates SshClient.execIsolated's (pre-fix) timeout message, which
    // embedded the full setup.sh command line — including
    // --webhook-token/--ui-token in plaintext — verbatim in the Error thrown
    // out of harnessInstaller.install(). Even with that message-level fix in
    // place, this route must not trust any error message reaching it to be
    // secret-free (defense in depth): a plaintext token in the message must
    // never survive into the persisted isolation_report.
    const install = vi.fn(async () => {
      throw new Error(
        "Isolated exec timed out: bash /harness/setup.sh --webhook-token 'abcdef0123456789abcdef0123456789' --ui-token 'deadbeefdeadbeefdeadbeefdeadbeef' --purge-operator-token",
      );
    });
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    const [, reportJson] = (opts.serverRepo.updateIsolationCleanupReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(reportJson).not.toContain('abcdef0123456789abcdef0123456789');
    expect(reportJson).not.toContain('deadbeefdeadbeefdeadbeefdeadbeef');
    const report = JSON.parse(reportJson);
    expect(report.cleanup).toBe('failed');
    expect(report.error).toContain('[redacted]');
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
    const [, reportJson] = (opts.serverRepo.updateIsolationCleanupReport as ReturnType<typeof vi.fn>).mock.calls[0];
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
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: null }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).toHaveBeenCalledTimes(1);
      expect(res.json().isolationCleanup).toBe('done');
      // Retrying must not re-flip isolation_intent (it was already true) —
      // only attemptIsolationCleanup's own updateIsolationCleanupReport() write runs.
      expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
    });

    it('retries when isolationReport.cleanup is "pending" (the atomic marker written by the original false->true flip)', async () => {
      const install = vi.fn(async () => ({ success: true, steps: [] }));
      const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'pending' }) }),
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
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'failed', error: 'boom' }) }),
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
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).not.toHaveBeenCalled();
      expect(opts.serverRepo.updateIsolationCleanupReport).not.toHaveBeenCalled();
      expect(res.json().isolationCleanup).toBeUndefined();
    });

    // Issue #29 review, Nit finding 3: `cleanup === 'done'` alone used to be
    // sufficient to skip a retry — but a report missing `kind` entirely (a
    // shape this route itself never writes, since attemptIsolationCleanup
    // always sets `kind: 'cleanup'`), or one whose `kind` is something else
    // (e.g. a future isolation doctor's `kind: 'verification'` write to the
    // same column — see Server.ts's isolationReport doc comment), must not
    // be trusted as a settled cleanup outcome just because it happens to
    // carry a `cleanup: 'done'`-shaped field.
    it('retries when isolationReport.cleanup is "done" but kind is missing', async () => {
      const install = vi.fn(async () => ({ success: true, steps: [] }));
      const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: JSON.stringify({ cleanup: 'done' }) }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).toHaveBeenCalledTimes(1);
    });

    it('retries when isolationReport.cleanup is "done" but kind is "verification" (not this route\'s own report)', async () => {
      const install = vi.fn(async () => ({ success: true, steps: [] }));
      const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(install) });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: JSON.stringify({ kind: 'verification', cleanup: 'done' }) }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

      expect(res.statusCode).toBe(200);
      expect(install).toHaveBeenCalledTimes(1);
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
      makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: '{"kind":"cleanup","cleanup":"done"}' }),
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
      makeServer({
        isolationIntent: true,
        isolationVerifiedAt: '2026-08-15T00:00:00Z',
        isolationReport: '{"findings":[]}',
        isolationCleanupReport: '{"kind":"cleanup","cleanup":"done"}',
      }),
    ]);
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers' });
    const body = res.json();

    expect(body[0].isolationIntent).toBe(true);
    expect(body[0].isolationVerifiedAt).toBe('2026-08-15T00:00:00Z');
    expect(body[0].isolationCleanupReport).toBeUndefined();
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
      makeServer({ isolationIntent: true, isolationVerifiedAt: null, isolationReport: '{"kind":"verification","verified":false,"checks":[]}' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/srv' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.isolationIntent).toBe(true);
    expect(JSON.parse(body.isolationReport).verified).toBe(false);
    expect(body.agentToken).toBeUndefined();
    expect(body.hasAgentToken).toBe(true);
  });

  // Review round (Important finding 4): isolationReport (verification) and
  // isolationCleanupReport (cleanup) are separate columns/fields now — the
  // detail route must surface both independently, not just whichever one
  // happened to be written most recently.
  it('returns isolationCleanupReport independently of isolationReport (column split, Important finding 4)', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({
        isolationIntent: true,
        isolationVerifiedAt: null,
        isolationReport: '{"kind":"verification","verified":false,"checks":[]}',
        isolationCleanupReport: '{"kind":"cleanup","cleanup":"failed","error":"ssh unreachable"}',
      }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'GET', url: '/api/servers/srv' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(body.isolationReport).kind).toBe('verification');
    expect(JSON.parse(body.isolationCleanupReport).kind).toBe('cleanup');
    expect(JSON.parse(body.isolationCleanupReport).cleanup).toBe('failed');
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

  // Issue #29 review, Important finding 1 (this pass): a true->true PUT
  // whose cleanup report never settled at 'done' (default makeServer() has
  // isolationCleanupReport: null) is NOT a full no-op — it retries
  // attemptIsolationCleanup (see the "true->true retries" describe block
  // below) — and that retry must go through the exact same risky-window
  // gate a false->true transition does. This test previously asserted 200
  // here, which encoded the bug this fix closes: the retry silently skipped
  // the gate entirely.
  it('rejects with 409 when a true->true retry (cleanup not yet done) finds a risky window', async () => {
    const findByServer = vi.fn(() => [
      { id: 1, windowType: 'agent', taskId: null } as unknown as ReturnType<NonNullable<ServersRouteOptions['windowRepo']>['findByServer']>[number],
    ]);
    const opts = makeOpts({ windowRepo: { findByServer } as unknown as ServersRouteOptions['windowRepo'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, isolationCleanupReport: null }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('isolation_intent_blocked_by_windows');
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  // A true->true PUT whose cleanup report is already settled at 'done'
  // needs no retry at all (isolationCleanupNeedsRetry short-circuits), so
  // the gate must never even run — a stale/unrelated window row must not
  // block a genuine complete no-op.
  it('does not gate a true->true PUT when the cleanup report is already settled at "done"', async () => {
    const findByServer = vi.fn(() => [
      { id: 1, windowType: 'agent', taskId: null } as unknown as ReturnType<NonNullable<ServersRouteOptions['windowRepo']>['findByServer']>[number],
    ]);
    const opts = makeOpts({ windowRepo: { findByServer } as unknown as ServersRouteOptions['windowRepo'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(findByServer).not.toHaveBeenCalled();
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
      tmux: { listSessionsForSecurityGate: vi.fn(async () => [{ name: 'manual-session', windowCount: 1, attached: false, created: 0, windows: [] }]) } as unknown as ServersRouteOptions['tmux'],
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
      tmux: { listSessionsForSecurityGate: vi.fn(async () => { throw new Error('ssh unreachable'); }) } as unknown as ServersRouteOptions['tmux'],
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
      tmux: { listSessionsForSecurityGate: vi.fn(async () => []) } as unknown as ServersRouteOptions['tmux'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });

  // Issue #29 review, Important finding 1 (this pass): the retry path must
  // check live sessions too — a stale/failed cleanup report (default
  // makeServer() isolationCleanupReport: null) means this true->true PUT is a
  // retry, not a no-op, and must be gated exactly like a false->true
  // transition. This test previously asserted the check was skipped, which
  // encoded the bug.
  it('rejects with 409 when a true->true retry (cleanup not yet done) finds a live tmux session', async () => {
    const listSessionsForSecurityGate = vi.fn(async () => [{ name: 'manual-session', windowCount: 1, attached: false, created: 0, windows: [] }]);
    const opts = makeOpts({ tmux: { listSessionsForSecurityGate } as unknown as ServersRouteOptions['tmux'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, isolationCleanupReport: null }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('isolation_intent_blocked_by_live_sessions');
    expect(listSessionsForSecurityGate).toHaveBeenCalledTimes(1);
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('does not check live sessions on a true->true PUT when the cleanup report is already settled at "done"', async () => {
    const listSessionsForSecurityGate = vi.fn(async () => []);
    const opts = makeOpts({ tmux: { listSessionsForSecurityGate } as unknown as ServersRouteOptions['tmux'] });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(listSessionsForSecurityGate).not.toHaveBeenCalled();
  });

  // Issue #29 review, Important finding 1 (this pass): once the risky-window
  // and live-session gate is clean, a not-yet-done cleanup report still
  // retries attemptIsolationCleanup exactly as before this fix — the gate
  // only blocks a dirty server, it does not disable the retry feature.
  it('runs the cleanup retry when the true->true gate finds no risky windows and no live sessions', async () => {
    const install = vi.fn(async () => ({ success: true, steps: [] }));
    const harnessInstaller = { install, installLocal: vi.fn() } as unknown as ServersRouteOptions['harnessInstaller'];
    const opts = makeOpts({
      harnessInstaller,
      tmux: { listSessionsForSecurityGate: vi.fn(async () => []) } as unknown as ServersRouteOptions['tmux'],
      windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: null }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(install).toHaveBeenCalledTimes(1);
    expect(res.json().isolationCleanup).toBe('done');
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

  // Issue #29 review (12th pass), Important finding 3: this used to be the
  // documented "escape hatch" — explicitly disabling isolation in the same
  // request as a connection change was accepted, because the gate keyed off
  // the EFFECTIVE end-state intent (`false` here), not the CURRENTLY
  // PERSISTED one. That is exactly the combination the finding flags:
  // `serverRepo.update()` (connection info) and
  // `serverRepo.updateIsolationIntent()` are two separate SQLite statements,
  // not one transaction, so a crash between them could leave the row
  // isolated=true with the NEW connection info already committed and
  // isolation_report still describing the OLD one. Now rejected outright —
  // the gate keys off `srv.isolationIntent` (the row as it stood BEFORE this
  // request), so this combination must be split into two requests (see the
  // next test for the two-step flow that IS still accepted).
  it('rejects with 400 when a connection-info change accompanies an explicit isolationIntent: true->false in the same request', async () => {
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

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_intent_blocks_connection_change');
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  // The two-step flow the message now directs callers to: a first PUT that
  // ONLY disables isolation (no connection-info field at all) is still
  // accepted — srv.isolationIntent is what the row was BEFORE this specific
  // request, and there is no connection change in this one to conflict with
  // it.
  it('allows a PUT that ONLY disables isolation (no connection-info field), as the first step of the two-step flow', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { isolationIntent: false },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', false);
  });

  // Second step of the two-step flow: once isolation has actually been
  // disabled (srv.isolationIntent is now false, reflecting the first PUT
  // having already committed), a connection-info change alone is accepted —
  // srv.isolationIntent === true is what gates this check, and it no longer
  // is.
  it('allows a connection-info change once isolation is already persisted as disabled (second step of the two-step flow)', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/srv',
      payload: { host: '9.9.9.9' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.update).toHaveBeenCalled();
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });
});

// Issue #29 review, Important finding 1: POST harness/install reads
// srv.isolationIntent (it decides whether the remote install withholds
// --ui-token / forces --purge-operator-token) and must do so under the same
// serverIsolationMutex as the isolation-intent PUT above, using only a row
// fetched INSIDE the lock — otherwise a normal install kicked off just
// before a false->true isolation PUT could read a stale `isolationIntent:
// false`, then complete (writing --ui-token back to the server) only AFTER
// the PUT's own cleanup already purged it.
describe('POST /api/servers/:name/harness/install — serialized via serverIsolationMutex (Issue #29 Important finding 1)', () => {
  function makeHarnessInstaller(installLocalImpl: ReturnType<typeof vi.fn>, installImpl: ReturnType<typeof vi.fn>) {
    return { installLocal: installLocalImpl, install: installImpl } as unknown as ServersRouteOptions['harnessInstaller'];
  }

  it('acquires serverIsolationMutex.withLock keyed by the server name before reading the row', async () => {
    const installLocal = vi.fn(async () => ({ success: true, steps: [] }));
    const withLock = vi.fn((key: string, fn: () => Promise<unknown>) => fn());
    const opts = makeOpts({
      harnessInstaller: makeHarnessInstaller(installLocal, vi.fn()),
      serverIsolationMutex: { withLock } as unknown as ServersRouteOptions['serverIsolationMutex'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'local' }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/harness/install', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(withLock).toHaveBeenCalledWith('srv', expect.any(Function));
    // findByName (the row read that feeds installOptions.isolationIntent)
    // must happen only once withLock has invoked its callback, not before.
    expect(opts.serverRepo.findByName).toHaveBeenCalledTimes(1);
  });

  it('uses the isolationIntent value from the row fetched inside the lock, not a value read beforehand', async () => {
    const installLocal = vi.fn(async () => ({ success: true, steps: [] }));
    const opts = makeOpts({ harnessInstaller: makeHarnessInstaller(installLocal, vi.fn()) });
    // findByName only ever returns the fresh (isolated) row — this simulates
    // a concurrent isolation PUT having already flipped isolation_intent to
    // true by the time this route's lock-protected read runs.
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'local', isolationIntent: true }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/harness/install', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(installLocal).toHaveBeenCalledWith(expect.objectContaining({ isolationIntent: true }));
  });

  it('serializes against a concurrent isolation-intent PUT on the same server (real KeyedMutex)', async () => {
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const install = vi.fn(async () => {
      await installGate;
      return { success: true, steps: [] };
    });
    const opts = makeOpts({
      harnessInstaller: makeHarnessInstaller(vi.fn(), install),
      serverIsolationMutex: new KeyedMutex(),
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const installPromise = app.inject({ method: 'POST', url: '/api/servers/srv/harness/install', payload: {} });
    // Give the install request a turn of the event loop to enter the lock
    // and start awaiting installGate before firing the PUT.
    await new Promise((resolve) => setImmediate(resolve));
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();

    const putPromise = app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });
    await new Promise((resolve) => setImmediate(resolve));
    // The PUT is queued behind the same key and must not have run yet.
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();

    releaseInstall();
    const [installRes, putRes] = await Promise.all([installPromise, putPromise]);

    expect(installRes.statusCode).toBe(200);
    expect(putRes.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });
});

// Issue #29 review, Important finding 2 (this pass): POST agent/install
// reads the row, runs a (potentially slow) remote install, and then writes
// a fresh host/agentPort/agentToken connection snapshot back onto it — the
// exact same "fresh read -> remote work -> write back connection info"
// shape harness/install above was already fixed (Important finding 1,
// earlier pass) to run inside serverIsolationMutex. This route was the one
// remaining place that pattern existed unwrapped.
describe('POST /api/servers/:name/agent/install — serialized via serverIsolationMutex (Issue #29 review, Important finding 2, this pass)', () => {
  function makeAgentInstaller(installImpl: ReturnType<typeof vi.fn>) {
    return { install: installImpl } as unknown as ServersRouteOptions['agentInstaller'];
  }

  it('acquires serverIsolationMutex.withLock keyed by the server name before reading the row', async () => {
    const install = vi.fn(async () => ({ success: true, host: '1.2.3.4', port: 4000, token: 'newtok', version: '1.0.1', startMethod: 'nohup' }));
    const withLock = vi.fn((key: string, fn: () => Promise<unknown>) => fn());
    const opts = makeOpts({
      agentInstaller: makeAgentInstaller(install),
      serverIsolationMutex: { withLock } as unknown as ServersRouteOptions['serverIsolationMutex'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/agent/install', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(withLock).toHaveBeenCalledWith('srv', expect.any(Function));
    expect(opts.serverRepo.findByName).toHaveBeenCalledTimes(1);
  });

  it('writes the fresh connection snapshot only from a row read inside the lock', async () => {
    const install = vi.fn(async () => ({ success: true, host: '5.6.7.8', port: 5000, token: 'newtok', version: '1.0.1', startMethod: 'nohup' }));
    const opts = makeOpts({ agentInstaller: makeAgentInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', sshHost: 'user@host', muxRuntime: 'managed' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/agent/install', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(install).toHaveBeenCalledWith('user@host', expect.any(Function), 'managed');
    expect(opts.serverRepo.update).toHaveBeenCalledWith('srv', 'agent', '5.6.7.8', 5000, 'newtok', 'user@host', 'managed');
  });

  it('serializes against a concurrent isolation-intent PUT on the same server (real KeyedMutex)', async () => {
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const install = vi.fn(async () => {
      await installGate;
      return { success: true, host: '1.2.3.4', port: 4000, token: 'newtok', version: '1.0.1', startMethod: 'nohup' };
    });
    const opts = makeOpts({
      agentInstaller: makeAgentInstaller(install),
      serverIsolationMutex: new KeyedMutex(),
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false, sshHost: 'user@host' }),
    );
    const app = await buildApp(opts);

    const installPromise = app.inject({ method: 'POST', url: '/api/servers/srv/agent/install', payload: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();

    const putPromise = app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });
    await new Promise((resolve) => setImmediate(resolve));
    // The PUT is queued behind the same key and must not have run yet.
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();

    releaseInstall();
    const [installRes, putRes] = await Promise.all([installPromise, putPromise]);

    expect(installRes.statusCode).toBe(200);
    expect(putRes.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });
});

describe('POST /api/servers/:name/agent/install — blocked while isolated (Issue #29 review, 14th pass, Important finding 2)', () => {
  function makeAgentInstaller(installImpl: ReturnType<typeof vi.fn>) {
    return { install: installImpl } as unknown as ServersRouteOptions['agentInstaller'];
  }

  it('rejects with 409 and never calls the installer when the server is isolated', async () => {
    const install = vi.fn(async () => ({ success: true, host: '1.2.3.4', port: 4000, token: 'newtok', version: '1.0.1', startMethod: 'nohup' }));
    const opts = makeOpts({ agentInstaller: makeAgentInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', sshHost: 'user@host', isolationIntent: true }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/agent/install', payload: {} });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'isolation_intent_blocks_agent_install' });
    expect(install).not.toHaveBeenCalled();
    expect(opts.serverRepo.update).not.toHaveBeenCalled();
  });

  it('proceeds normally when the server is not isolated', async () => {
    const install = vi.fn(async () => ({ success: true, host: '1.2.3.4', port: 4000, token: 'newtok', version: '1.0.1', startMethod: 'nohup' }));
    const opts = makeOpts({ agentInstaller: makeAgentInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', sshHost: 'user@host', isolationIntent: false }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/agent/install', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(install).toHaveBeenCalledTimes(1);
  });
});

// Issue #29 Step 2, C-1 裁定: isolation_intent の有効化には scoped auth が
// 必須。互換モード（scopedAuthEnabled === false）では層3の API 認可が
// would_deny（監査ログのみ、実際には通す）でしかないため、隔離を宣言できて
// しまうと実態より安全に見える。
describe('PUT /api/servers/:name — isolation_intent requires scoped auth (Issue #29 Step 2, C-1)', () => {
  function makeHarnessInstaller(installImpl: ReturnType<typeof vi.fn>) {
    return { install: installImpl, installLocal: vi.fn() } as unknown as ServersRouteOptions['harnessInstaller'];
  }

  it('rejects a false->true declaration with 409 when scopedAuthEnabled is false', async () => {
    const opts = makeOpts({ scopedAuthEnabled: false });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('isolation_intent_requires_scoped_auth');
    expect(opts.serverRepo.updateIsolationIntent).not.toHaveBeenCalled();
  });

  it('allows a false->true declaration when scopedAuthEnabled is true', async () => {
    const opts = makeOpts({ scopedAuthEnabled: true });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: false }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', true);
  });

  it('rejects a true->true retry (cleanup not yet done) with 409 when scopedAuthEnabled is false', async () => {
    const install = vi.fn(async () => ({ success: true, steps: [] }));
    const opts = makeOpts({ scopedAuthEnabled: false, harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: null }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('isolation_intent_requires_scoped_auth');
    expect(install).not.toHaveBeenCalled();
  });

  it('does not gate a true->true PUT already settled at "done", even with scopedAuthEnabled false', async () => {
    const install = vi.fn(async () => ({ success: true, steps: [] }));
    const opts = makeOpts({ scopedAuthEnabled: false, harnessInstaller: makeHarnessInstaller(install) });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, sshHost: 'user@host', isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: true } });

    expect(res.statusCode).toBe(200);
    expect(install).not.toHaveBeenCalled();
  });

  it('always allows disabling isolation (isolationIntent: false) regardless of scopedAuthEnabled', async () => {
    const opts = makeOpts({ scopedAuthEnabled: false });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { isolationIntent: false } });

    expect(res.statusCode).toBe(200);
    expect(opts.serverRepo.updateIsolationIntent).toHaveBeenCalledWith('srv', false);
  });

  it('does not block a plain PUT that never mentions isolationIntent, even with scopedAuthEnabled false', async () => {
    const opts = makeOpts({ scopedAuthEnabled: false });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv', payload: { host: '5.6.7.8' } });

    expect(res.statusCode).toBe(200);
  });
});

// Issue #29 Step 2 B: POST /api/servers/:name/isolation/doctor.
describe('POST /api/servers/:name/isolation/doctor (Issue #29 Step 2 B)', () => {
  it('400s when the server is not agent-type', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'local' }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('isolation_doctor_requires_isolated_agent_server');
  });

  it('400s when the server has not declared isolationIntent', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

    expect(res.statusCode).toBe(400);
  });

  it('404s for an unknown server', async () => {
    const opts = makeOpts();
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/missing/isolation/doctor' });

    expect(res.statusCode).toBe(404);
  });

  // Issue #29 review (5th pass), Important finding 1: C-1 gates the
  // false->true isolationIntent *declaration* PUT behind scoped auth, but
  // this route (running the doctor against an ALREADY-isolated row) never
  // checked scopedAuthEnabled at all — a compat-mode hub could still
  // persist a fresh isolation_verified_at and render "検証済み" for a
  // server whose declared isolation the system as a whole does not actually
  // enforce. This block covers the fix: the doctor route now applies the
  // same 409 gate the PUT handler already does.
  describe('requires scoped auth (Issue #29 review, 5th pass, Important finding 1 / C-1 doctor gate)', () => {
    it('409s and never invokes the transport when scopedAuthEnabled is false', async () => {
      const exec = vi.fn();
      const opts = makeOpts({
        scopedAuthEnabled: false,
        transportFactory: { getTransport: vi.fn(() => ({ exec })), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
      });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
      );
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('isolation_doctor_requires_scoped_auth');
      expect(exec).not.toHaveBeenCalled();
      expect(opts.serverRepo.updateIsolationVerification).not.toHaveBeenCalled();
      expect(opts.serverRepo.updateIsolationReport).not.toHaveBeenCalled();
    });

    it('still 400s the non-isolated/non-agent precondition first, even when scopedAuthEnabled is false', async () => {
      const opts = makeOpts({ scopedAuthEnabled: false });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'agent', isolationIntent: false }));
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('isolation_doctor_requires_isolated_agent_server');
    });
  });

  // Security fix (same_host boot_id-based detection): a boot_id probe that
  // resolves to a value DIFFERENT from the hub's own (real, unmocked)
  // boot_id resolves `same_host` to 'pass' regardless of hostname/uid — so a
  // run where every other check is also clean reaches `verified: true`
  // overall and persists via `updateIsolationVerification`.
  it('runs the probe for an isolated agent server and persists verification via transportFactory.getTransport when every check (including same_host) passes', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('hostname;')) return { stdout: 'remote-host\n9999\n', stderr: '', code: 0 };
      if (cmd.includes('/proc/sys/kernel/random/boot_id')) return FAKE_REMOTE_BOOT_ID_RESPONSE;
      // Review round (Critical finding 1): the FS-boundary canary probe —
      // a different command than the plain hostname/uid one above, matched
      // by the mocked hub canary's path (see the vi.mock('./hubCanary')
      // block at the top of this file). Reports absent — no longer decisive
      // for `same_host` on its own (the boot_id probe above decides it).
      if (cmd.includes('.azito-hub-canary-test')) return { stdout: 'AZT_STATUS:canary:absent\n', stderr: '', code: 0 };
      if (cmd.includes('.ssh')) return { stdout: 'AZT_SSH_NO_DIR\n', stderr: '', code: 0 };
      if (cmd.includes('hosts.yml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_GH_CHECK_DONE')) return { stdout: 'AZT_GH_ABSENT\nAZT_GH_CHECK_DONE\n', stderr: '', code: 0 };
      if (cmd.includes('credential.helper')) return { stdout: 'AZT_GIT_EXIT:1\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
      if (cmd.includes('$HOME"')) return { stdout: '/home/remote\n', stderr: '', code: 0 };
      if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_STATUS:absent\n', stderr: '', code: 0 };
      if (cmd.includes('SSH_AUTH_SOCK')) return { stdout: 'AZT_NO_SOCK\n', stderr: '', code: 0 };
      // Review round (Critical finding 2): file probes now report
      // presence/absence via a framed `AZT_STATUS:<key>:...` line instead of
      // the old bare `AZT_FILE_ABSENT` marker — see probeFilesFramed's doc
      // comment in isolationDoctor.ts.
      if (cmd.includes('.claude/settings.json')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('config.toml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      // Review round (Critical finding 3): the new operator-environment
      // check — no operator variables set, so only the terminator line.
      if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const opts = makeOpts({
      transportFactory: { getTransport: vi.fn(() => ({ exec })), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verified).toBe(true);
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.find((c: { id: string }) => c.id === 'same_host').status).toBe('pass');
    expect(opts.serverRepo.updateIsolationVerification).toHaveBeenCalledWith('srv', expect.stringContaining('"kind":"verification"'), expect.any(String));
  });

  it('does not advance isolation_verified_at when a check fails', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('hostname;')) return { stdout: 'remote-host\n9999\n', stderr: '', code: 0 };
      if (cmd.includes('.azito-hub-canary-test')) return { stdout: 'AZT_STATUS:canary:absent\n', stderr: '', code: 0 };
      if (cmd.includes('.ssh')) return { stdout: '/home/remote/.ssh/id_rsa\nAZT_SSH_DIR_EXISTS\n', stderr: '', code: 0 };
      if (cmd.includes('hosts.yml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_GH_CHECK_DONE')) return { stdout: 'AZT_GH_ABSENT\nAZT_GH_CHECK_DONE\n', stderr: '', code: 0 };
      if (cmd.includes('credential.helper')) return { stdout: 'AZT_GIT_EXIT:1\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
      if (cmd.includes('$HOME"')) return { stdout: '/home/remote\n', stderr: '', code: 0 };
      if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_STATUS:absent\n', stderr: '', code: 0 };
      if (cmd.includes('SSH_AUTH_SOCK')) return { stdout: 'AZT_NO_SOCK\n', stderr: '', code: 0 };
      if (cmd.includes('.claude/settings.json')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('config.toml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const opts = makeOpts({
      transportFactory: { getTransport: vi.fn(() => ({ exec })), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
      makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
    );
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(false);
    expect(opts.serverRepo.updateIsolationVerification).not.toHaveBeenCalled();
    // Issue #29 review Step 3a, Critical finding 1: a failing run now goes
    // through updateIsolationFailure (report + atomic isolation_verified_at
    // clear), not the plain updateIsolationReport (report only) — see that
    // method's doc comment on IServerRepository for why leaving a prior
    // pass's verified_at untouched here would keep 'allow' silently
    // effective for up to ISOLATION_VERIFICATION_TTL_MS after isolation
    // actually broke.
    expect(opts.serverRepo.updateIsolationFailure).toHaveBeenCalledWith('srv', expect.stringContaining('"verified":false'));
    expect(opts.serverRepo.updateIsolationReport).not.toHaveBeenCalled();
  });

  // Issue #29 review Step 3a, Critical finding 1: regression coverage for
  // the exact scenario the fix closes — a PASSING doctor run sets
  // isolation_verified_at, a LATER FAILING run must invalidate it instead of
  // leaving it valid within its TTL window.
  it('clears a prior passing isolation_verified_at when a later doctor run fails (pass -> fail)', async () => {
    // Real repository this time (not a mock), so the atomic clear inside
    // updateIsolationFailure's own UPDATE statement is exercised for real,
    // not merely asserted-called-with on a stub.
    const { SqliteServerRepository } = await import('./SqliteServerRepository.js');
    const { openDatabase } = await import('../../shared/db/Database.js');
    const db = openDatabase(':memory:');
    const realServerRepo = new SqliteServerRepository(db);
    realServerRepo.create('srv', 'agent', '1.2.3.4', 3002);
    realServerRepo.updateIsolationIntent('srv', true);

    const passingReport = JSON.stringify({ kind: 'verification', verified: true, checks: [], probedAt: new Date().toISOString() });
    realServerRepo.updateIsolationVerification('srv', passingReport, new Date().toISOString());
    expect(realServerRepo.findByName('srv')?.isolationVerifiedAt).not.toBeNull();

    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith('hostname;')) return { stdout: 'remote-host\n9999\n', stderr: '', code: 0 };
      if (cmd.includes('.azito-hub-canary-test')) return { stdout: 'AZT_STATUS:canary:absent\n', stderr: '', code: 0 };
      if (cmd.includes('.ssh')) return { stdout: '/home/remote/.ssh/id_rsa\nAZT_SSH_DIR_EXISTS\n', stderr: '', code: 0 };
      if (cmd.includes('hosts.yml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_GH_CHECK_DONE')) return { stdout: 'AZT_GH_ABSENT\nAZT_GH_CHECK_DONE\n', stderr: '', code: 0 };
      if (cmd.includes('credential.helper')) return { stdout: 'AZT_GIT_EXIT:1\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
      if (cmd.includes('$HOME"')) return { stdout: '/home/remote\n', stderr: '', code: 0 };
      if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_STATUS:absent\n', stderr: '', code: 0 };
      if (cmd.includes('SSH_AUTH_SOCK')) return { stdout: 'AZT_NO_SOCK\n', stderr: '', code: 0 };
      if (cmd.includes('.claude/settings.json')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('config.toml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const opts = makeOpts({
      serverRepo: realServerRepo,
      transportFactory: { getTransport: vi.fn(() => ({ exec })), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
    });
    const app = await buildApp(opts);

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(false);
    // The prior PASSING run's isolation_verified_at must not survive this
    // failing run.
    expect(realServerRepo.findByName('srv')?.isolationVerifiedAt).toBeNull();
    db.close();
  });

  // Step 2 review, Important #2: the lookup->probe->persist span used to run
  // OUTSIDE serverIsolationMutex — a concurrent PUT (isolationIntent flip,
  // connection-info change) could commit mid-probe and this route would
  // still persist a "verified" report describing stale state. The whole
  // span (including the initial serverRepo.findByName lookup, which the fix
  // moved from before the lock to inside it) must now run inside the same
  // per-server-name mutex the PUT/installer routes use.
  describe('serializes against serverIsolationMutex (Step 2 review, Important #2)', () => {
    it('does not even look up the server until a lock held by another operation on the same name is released', async () => {
      const opts = makeOpts();
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
      );
      let releaseLock: () => void = () => {};
      const blocker = new Promise<void>((resolve) => { releaseLock = resolve; });
      // Pre-acquire the lock for 'srv', simulating an in-flight PUT/installer
      // operation on the same server that hasn't committed yet.
      const heldLock = opts.serverIsolationMutex.withLock('srv', async () => { await blocker; });
      const app = await buildApp(opts);

      const doctorRes = app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });
      // Give the event loop a few turns — if the route's findByName ran
      // outside the lock (the bug this fix closes), it would have already
      // been called by now.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opts.serverRepo.findByName).not.toHaveBeenCalled();

      releaseLock();
      await heldLock;
      await doctorRes;
      expect(opts.serverRepo.findByName).toHaveBeenCalled();
    });

    it('re-validates the agent/isolated precondition against state committed while this request was queued for the lock', async () => {
      const opts = makeOpts();
      // Simulates a PUT that flips isolationIntent false->true->false again
      // (or a cleanup) while the doctor request was queued behind the lock —
      // by the time the doctor's own fn actually runs (post-lock), the
      // server no longer satisfies the precondition. The stale pre-lock
      // lookup this fix removed would have missed this entirely.
      let isolated = true;
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeServer({ type: 'agent', isolationIntent: isolated, host: '1.2.3.4' }),
      );
      const heldLock = opts.serverIsolationMutex.withLock('srv', async () => {
        isolated = false;
      });
      const app = await buildApp(opts);

      const doctorRes = await Promise.all([heldLock, app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' })]).then(([, res]) => res);

      expect(doctorRes.statusCode).toBe(400);
      expect(doctorRes.json().error).toBe('isolation_doctor_requires_isolated_agent_server');
    });
  });

  // Isolation doctor review, Important finding 3: POST /api/servers/:name/isolation/doctor
  // was already the only lock-holder for its own findByName->probe->persist
  // span, but POST /api/servers (create) and DELETE /api/servers/:name ran
  // OUTSIDE serverIsolationMutex entirely — a slow doctor probe could have a
  // same-name delete+recreate race past it underneath, and the doctor would
  // still persist a "verified" report describing a server that no longer
  // exists (or that was replaced). Fixed two ways: (1) POST create / DELETE
  // now take the same per-server-name lock as the doctor (below), and (2) as
  // defense in depth, the doctor re-reads the row one more time immediately
  // before persisting and aborts on any identity mismatch, reusing the same
  // ServerSnapshotMismatchError convention `refetchServer` already throws
  // elsewhere (ServerIsolationLock.ts).
  describe('serverIsolationMutex also serializes POST /api/servers and DELETE /api/servers/:name (isolation doctor review, Important finding 3)', () => {
    it('POST /api/servers acquires serverIsolationMutex.withLock keyed by the new server name', async () => {
      const withLock = vi.fn((key: string, fn: () => Promise<unknown>) => fn());
      const opts = makeOpts({ serverIsolationMutex: { withLock } as unknown as ServersRouteOptions['serverIsolationMutex'] });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'POST', url: '/api/servers', payload: { name: 'new-srv', type: 'local' } });

      expect(res.statusCode).toBe(200);
      expect(withLock).toHaveBeenCalledWith('new-srv', expect.any(Function));
    });

    it('DELETE /api/servers/:name acquires serverIsolationMutex.withLock keyed by the server name', async () => {
      const withLock = vi.fn((key: string, fn: () => Promise<unknown>) => fn());
      const opts = makeOpts({ serverIsolationMutex: { withLock } as unknown as ServersRouteOptions['serverIsolationMutex'] });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(makeServer({ type: 'local' }));
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv' });

      expect(res.statusCode).toBe(200);
      expect(withLock).toHaveBeenCalledWith('srv', expect.any(Function));
    });

    it('a slow doctor probe blocks a concurrent same-name DELETE, then a concurrent same-name POST recreate, until the probe finishes (real KeyedMutex)', async () => {
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
      const exec = vi.fn(async (cmd: string) => {
        await probeGate;
        if (cmd.startsWith('hostname;')) return { stdout: 'remote-host\n9999\n', stderr: '', code: 0 };
        if (cmd.includes('.azito-hub-canary-test')) return { stdout: 'AZT_STATUS:canary:absent\n', stderr: '', code: 0 };
        if (cmd.includes('.ssh')) return { stdout: 'AZT_SSH_NO_DIR\n', stderr: '', code: 0 };
        if (cmd.includes('hosts.yml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_GH_CHECK_DONE')) return { stdout: 'AZT_GH_ABSENT\nAZT_GH_CHECK_DONE\n', stderr: '', code: 0 };
        if (cmd.includes('credential.helper')) return { stdout: 'AZT_GIT_EXIT:1\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
        if (cmd.includes('$HOME"')) return { stdout: '/home/remote\n', stderr: '', code: 0 };
        if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_STATUS:absent\n', stderr: '', code: 0 };
        if (cmd.includes('SSH_AUTH_SOCK')) return { stdout: 'AZT_NO_SOCK\n', stderr: '', code: 0 };
        if (cmd.includes('.claude/settings.json')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
        if (cmd.includes('config.toml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
        if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      });
      const opts = makeOpts({
        transportFactory: { getTransport: vi.fn(() => ({ exec })), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
        serverIsolationMutex: new KeyedMutex(),
      });
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(
        makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' }),
      );
      const app = await buildApp(opts);

      const doctorPromise = app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(opts.serverRepo.delete).not.toHaveBeenCalled();

      const deletePromise = app.inject({ method: 'DELETE', url: '/api/servers/srv' });
      await new Promise((resolve) => setImmediate(resolve));
      // Queued behind the doctor's held lock — must not have run yet.
      expect(opts.serverRepo.delete).not.toHaveBeenCalled();

      releaseProbe();
      const [doctorRes, deleteRes] = await Promise.all([doctorPromise, deletePromise]);

      expect(doctorRes.statusCode).toBe(200);
      expect(deleteRes.statusCode).toBe(200);
      expect(opts.serverRepo.delete).toHaveBeenCalledWith('srv');
    });

    it('defense in depth: aborts without persisting when the row read right before persist differs in identity from the one the probe started against', async () => {
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.startsWith('hostname;')) return { stdout: 'remote-host\n9999\n', stderr: '', code: 0 };
        if (cmd.includes('.azito-hub-canary-test')) return { stdout: 'AZT_STATUS:canary:absent\n', stderr: '', code: 0 };
        if (cmd.includes('.ssh')) return { stdout: 'AZT_SSH_NO_DIR\n', stderr: '', code: 0 };
        if (cmd.includes('hosts.yml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_GH_CHECK_DONE')) return { stdout: 'AZT_GH_ABSENT\nAZT_GH_CHECK_DONE\n', stderr: '', code: 0 };
        if (cmd.includes('credential.helper')) return { stdout: 'AZT_GIT_EXIT:1\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
        if (cmd.includes('$HOME"')) return { stdout: '/home/remote\n', stderr: '', code: 0 };
        if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_STATUS:absent\n', stderr: '', code: 0 };
        if (cmd.includes('SSH_AUTH_SOCK')) return { stdout: 'AZT_NO_SOCK\n', stderr: '', code: 0 };
        if (cmd.includes('.claude/settings.json')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
        if (cmd.includes('config.toml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
        if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      });
      const opts = makeOpts({
        transportFactory: { getTransport: vi.fn(() => ({ exec })), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
      });
      const original = makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4', createdAt: '2026-01-01T00:00:00Z' });
      // Simulates a delete+recreate landing between the two reads within the
      // same lock hold — createdAt is the one field that changes on every
      // INSERT even when every connection field is set back identically.
      const recreated = { ...original, createdAt: '2026-01-01T00:00:05Z' };
      let calls = 0;
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(() => {
        calls += 1;
        return calls === 1 ? original : recreated;
      });
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('server_identity_changed_during_probe');
      expect(opts.serverRepo.updateIsolationVerification).not.toHaveBeenCalled();
      expect(opts.serverRepo.updateIsolationReport).not.toHaveBeenCalled();
    });

    it('defense in depth: aborts without persisting when the server was deleted between the initial read and the persist-time re-read', async () => {
      const exec = vi.fn(async (cmd: string) => {
        if (cmd.startsWith('hostname;')) return { stdout: 'remote-host\n9999\n', stderr: '', code: 0 };
        if (cmd.includes('.azito-hub-canary-test')) return { stdout: 'AZT_STATUS:canary:absent\n', stderr: '', code: 0 };
        if (cmd.includes('.ssh')) return { stdout: 'AZT_SSH_NO_DIR\n', stderr: '', code: 0 };
        if (cmd.includes('hosts.yml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
      if (cmd.includes('AZT_GH_CHECK_DONE')) return { stdout: 'AZT_GH_ABSENT\nAZT_GH_CHECK_DONE\n', stderr: '', code: 0 };
        if (cmd.includes('credential.helper')) return { stdout: 'AZT_GIT_EXIT:1\nAZT_HELPER_END\nAZT_CREDFILE_ABSENT\n', stderr: '', code: 0 };
        if (cmd.includes('$HOME"')) return { stdout: '/home/remote\n', stderr: '', code: 0 };
        if (cmd.includes('ls -1')) return { stdout: 'AZT_LS_STATUS:absent\n', stderr: '', code: 0 };
        if (cmd.includes('SSH_AUTH_SOCK')) return { stdout: 'AZT_NO_SOCK\n', stderr: '', code: 0 };
        if (cmd.includes('.claude/settings.json')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
        if (cmd.includes('config.toml')) return { stdout: 'AZT_STATUS:f:absent\n', stderr: '', code: 0 };
        if (cmd.includes('AZT_ENV_PRESENT')) return { stdout: 'AZT_ENV_DONE\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      });
      const opts = makeOpts({
        transportFactory: { getTransport: vi.fn(() => ({ exec })), invalidate: vi.fn() } as unknown as ServersRouteOptions['transportFactory'],
      });
      const original = makeServer({ type: 'agent', isolationIntent: true, host: '1.2.3.4' });
      let calls = 0;
      (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(() => {
        calls += 1;
        return calls === 1 ? original : null;
      });
      const app = await buildApp(opts);

      const res = await app.inject({ method: 'POST', url: '/api/servers/srv/isolation/doctor' });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('server_deleted_during_probe');
      expect(opts.serverRepo.updateIsolationVerification).not.toHaveBeenCalled();
      expect(opts.serverRepo.updateIsolationReport).not.toHaveBeenCalled();
    });
  });
});
