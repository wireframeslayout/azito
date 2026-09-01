import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import BetterSqlite3 from 'better-sqlite3';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';
import { TaskOriginationService } from '../tasks/origination/TaskOriginationService';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { KeyedMutex } from '../../shared/keyedMutex';
import type { ServerConfig, ServerMeta } from '../servers/Server';
import { SqliteServerRepository } from '../servers/SqliteServerRepository';
import type { SqliteDatabase } from '../../shared/db/Database';
import type { ProjectServer } from './ProjectServer';
import type { FetchDistributionService } from '../git/hub-transfer/FetchDistributionService';
import type { ProjectRepositoryCredential } from './Project';
import { resolveCliTokens, getCliTokenSync, type CliTokenTarget } from '../git/providers/cliToken';

// The hub's own `gh`/`glab` login must never be consulted for real from a
// unit test — the verdict would then depend on whoever is logged in on the
// machine running it. Stubbed to "no CLI credentials" by default; the
// two-stage-resolution tests below opt in explicitly.
vi.mock('../git/providers/cliToken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git/providers/cliToken')>();
  return {
    ...actual,
    resolveCliTokens: vi.fn(async () => actual.NO_CLI_TOKEN),
    // Blocking, event-loop-stalling variant: this listing must never reach it.
    getCliTokenSync: vi.fn(() => { throw new Error('GET /api/projects/:id/servers must never resolve a CLI token synchronously'); }),
  };
});
const mockedResolveCliTokens = vi.mocked(resolveCliTokens);
const mockedGetCliTokenSync = vi.mocked(getCliTokenSync);

beforeEach(() => {
  mockedResolveCliTokens.mockReset();
  mockedResolveCliTokens.mockResolvedValue(() => null);
  mockedGetCliTokenSync.mockClear();
});

// Issue #87 配信状態の可視化: GET /api/projects/:id/servers must answer
// "is this pairing distributable, and when did it last receive code?"
// WITHOUT running a task — the misconfiguration this closes (the project
// wizard's "use an existing directory" branch leaving
// distribution_repository_id NULL on an isolated server) was previously
// invisible until the first task failed on `no_distribution_repository`.

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'iso-1', type: 'agent', host: '10.0.0.2', agentPort: 4000, agentToken: 't', agentVersion: null,
    sshHost: 'iso-1', muxRuntime: 'tmux', sshHostFingerprint: null,
    isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null,
    createdAt: '2026-01-01T00:00:00Z', ...overrides,
  } as ServerConfig;
}

/** The non-secret projection the listing actually reads — see IServerRepository.findMetaByNames. */
function toMeta(server: ServerConfig): ServerMeta {
  return { name: server.name, type: server.type, isolationIntent: server.isolationIntent };
}

function makeProjectServer(overrides: Partial<ProjectServer> = {}): ProjectServer {
  return {
    projectId: 10, serverName: 'iso-1', workingDirectory: '/home/agent/work', branch: null,
    tmuxSession: 'azito', inputPolicy: 'manual-approval', distributeCode: false, distributionRepositoryId: 1,
    ...overrides,
  };
}

const repositories = [
  { id: 1, name: 'widgets', url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: true },
  { id: 2, name: 'gadgets', url: 'https://github.com/acme/gadgets.git', provider: 'github' as const, owner: 'acme', repoName: 'gadgets', hasToken: true },
  { id: 3, name: 'sprockets', url: 'https://github.com/acme/sprockets.git', provider: 'github' as const, owner: 'acme', repoName: 'sprockets', hasToken: true },
];

function makeCredential(overrides: Partial<ProjectRepositoryCredential> = {}): ProjectRepositoryCredential {
  const id = overrides.id ?? 1;
  const base = repositories.find((r) => r.id === id) ?? repositories[0];
  return { id, name: base.name, url: base.url, provider: 'github', owner: base.owner, repoName: base.repoName, credentialStatus: 'ok', token: 'ghp_x', ...overrides };
}

function makeOpts(overrides: Partial<ProjectsRouteOptions> = {}): ProjectsRouteOptions {
  const taskRepo = {
    findAll: vi.fn(() => []), findByProject: vi.fn(() => []), findByUnit: vi.fn(() => []), findByStatus: vi.fn(() => []),
    findAgentSessionIdsByServer: vi.fn(() => new Set<string>()), findById: vi.fn(() => null), create: vi.fn(() => 99),
    update: vi.fn(), updateStatus: vi.fn(), updateCurrentPhase: vi.fn(), touch: vi.fn(), delete: vi.fn(),
    consumePendingApproval: vi.fn(() => false), recordExecutionGateBlock: vi.fn(() => true), preApproveExecution: vi.fn(() => true),
    countChildren: vi.fn(() => 0), countChildrenInGeneration: vi.fn(() => 0), clearTmuxWindowIfMatches: vi.fn(() => true),
    updateStatusIfWindowMatches: vi.fn(() => true),
  } as ProjectsRouteOptions['taskRepo'];
  const originationService = new TaskOriginationService(taskRepo, { record: vi.fn() } as unknown as AuditLogService);

  return {
    projectRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, repositories, windows: [], createdAt: '', updatedAt: '' })),
      create: vi.fn(() => 10), update: vi.fn(), delete: vi.fn(), addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => { throw new Error('the listing must never take the throwing single-row path'); }),
      updateRepositoryToken: vi.fn(), removeRepository: vi.fn(),
      findRepositoryCredentialsByIds: vi.fn((ids: number[]) => ids.map((id) => makeCredential({ id }))),
    },
    projectServerRepo: {
      findByProject: vi.fn(() => [makeProjectServer()]),
      findByServer: vi.fn(() => []), find: vi.fn(() => null), upsert: vi.fn(), remove: vi.fn(),
    },
    taskRepo,
    originationService,
    gitProvider: { getIssue: vi.fn() } as unknown as ProjectsRouteOptions['gitProvider'],
    tmux: { listSessions: vi.fn(async () => []), createSession: vi.fn(async () => {}) } as unknown as ProjectsRouteOptions['tmux'],
    serverRepo: {
      // Throws on purpose: this listing must never take the credential-decrypting
      // path (`findAll()` -> `toEntity()` -> `SecretBox.open()`), which one broken
      // `agent_token` anywhere in the table would turn into a 500.
      findAll: vi.fn((): ServerConfig[] => { throw new Error('the listing must never read every server through toEntity()'); }),
      findByName: vi.fn(() => null), create: vi.fn(), update: vi.fn(),
      updateAgentVersion: vi.fn(), updateFingerprint: vi.fn(), clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(),
      findMetaByNames: vi.fn((names: string[]) => [makeServer()].filter((s) => names.includes(s.name)).map(toMeta)),
      delete: vi.fn(),
    },
    projectSecretRepo: { findByProject: vi.fn(() => []) } as unknown as ProjectsRouteOptions['projectSecretRepo'],
    serverIsolationMutex: new KeyedMutex(),
    repoDiscovery: { discover: vi.fn(async () => []) } as unknown as ProjectsRouteOptions['repoDiscovery'],
    localRepoCloneService: { clone: vi.fn() } as unknown as ProjectsRouteOptions['localRepoCloneService'],
    distributionStateRepo: { upsert: vi.fn(), deleteByServer: vi.fn(), find: vi.fn(() => null), findManyByRepositoryIds: vi.fn(() => []) },
    fetchDistributionService: {} as FetchDistributionService,
    ...overrides,
  };
}

async function getServers(opts: ProjectsRouteOptions) {
  const app = Fastify();
  await app.register(projectsRoutes, opts);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/projects/10/servers' });
  await app.close();
  return res;
}

describe('GET /api/projects/:id/servers — distribution status (Issue #87 配信状態の可視化)', () => {
  it('reports a distributed environment: required, prerequisites ok, and the last-distribution record', async () => {
    const opts = makeOpts({
      distributionStateRepo: {
        upsert: vi.fn(), deleteByServer: vi.fn(), find: vi.fn(() => null),
        findManyByRepositoryIds: vi.fn(() => [{ serverName: 'iso-1', repositoryId: 1, lastDistributedSha: 'a'.repeat(40), bundleType: 'incremental' as const, distributedAt: '2026-08-30T10:00:00Z' }]),
      },
    });
    const res = await getServers(opts);
    expect(res.statusCode).toBe(200);
    const [row] = res.json();
    expect(row.distributionRequired).toBe(true);
    expect(row.distributionPrerequisite).toEqual({ status: 'ok', stage: null, credentialSource: 'repository' });
    expect(row.lastDistribution).toEqual({ distributedAt: '2026-08-30T10:00:00Z', bundleType: 'incremental', lastDistributedSha: 'a'.repeat(40) });
    // Pre-existing fields are untouched.
    expect(row.serverName).toBe('iso-1');
    expect(row.workingDirectory).toBe('/home/agent/work');
    expect(row.distributionRepositoryId).toBe(1);
  });

  it('reports lastDistribution: null for a never-distributed environment whose prerequisites nonetheless pass', async () => {
    const res = await getServers(makeOpts());
    const [row] = res.json();
    expect(row.distributionPrerequisite).toEqual({ status: 'ok', stage: null, credentialSource: 'repository' });
    expect(row.lastDistribution).toBeNull();
  });

  it('reports the no_distribution_repository stage for the project-wizard gap (isolated server, distribution_repository_id NULL)', async () => {
    const opts = makeOpts({
      projectServerRepo: { ...makeOpts().projectServerRepo, findByProject: vi.fn(() => [makeProjectServer({ distributionRepositoryId: null })]) },
    });
    const [row] = (await getServers(opts)).json();
    expect(row.distributionRequired).toBe(true);
    expect(row.distributionPrerequisite).toEqual({ status: 'failed', stage: 'no_distribution_repository', credentialSource: null });
    expect(row.lastDistribution).toBeNull();
  });

  it('reports distribution_repository_not_found when the configured repository is gone from the project', async () => {
    const opts = makeOpts({
      projectServerRepo: { ...makeOpts().projectServerRepo, findByProject: vi.fn(() => [makeProjectServer({ distributionRepositoryId: 42 })]) },
    });
    const [row] = (await getServers(opts)).json();
    expect(row.distributionPrerequisite).toEqual({ status: 'failed', stage: 'distribution_repository_not_found', credentialSource: null });
  });

  it('reports no_working_dir when the pairing has no working directory configured', async () => {
    const opts = makeOpts({
      projectServerRepo: { ...makeOpts().projectServerRepo, findByProject: vi.fn(() => [makeProjectServer({ workingDirectory: null })]) },
    });
    const [row] = (await getServers(opts)).json();
    expect(row.distributionPrerequisite).toEqual({ status: 'failed', stage: 'no_working_dir', credentialSource: null });
  });

  it('reports no_token when the target repository has no credential', async () => {
    const base = makeOpts();
    const opts = makeOpts({
      projectRepo: { ...base.projectRepo, findRepositoryCredentialsByIds: vi.fn(() => [makeCredential({ credentialStatus: 'absent', token: null })]) },
    });
    const [row] = (await getServers(opts)).json();
    expect(row.distributionPrerequisite).toEqual({ status: 'failed', stage: 'no_token', credentialSource: null });
  });

  it('reports no_token when the target repository row is gone entirely', async () => {
    const base = makeOpts();
    const opts = makeOpts({ projectRepo: { ...base.projectRepo, findRepositoryCredentialsByIds: vi.fn(() => []) } });
    const [row] = (await getServers(opts)).json();
    expect(row.distributionPrerequisite).toEqual({ status: 'failed', stage: 'no_token', credentialSource: null });
  });

  it('reports identity_unresolvable WITHOUT leaking the repository URL or the internal message', async () => {
    const base = makeOpts();
    const opts = makeOpts({
      projectRepo: { ...base.projectRepo, findRepositoryCredentialsByIds: vi.fn(() => [makeCredential({ url: 'https://user:secret@example.invalid/not a repo' })]) },
    });
    const res = await getServers(opts);
    const [row] = res.json();
    expect(row.distributionPrerequisite).toEqual({ status: 'failed', stage: 'identity_unresolvable', credentialSource: null });
    expect(row.distributionPrerequisite).not.toHaveProperty('message');
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('example.invalid');
  });

  // ── Two-stage token resolution (docs/ja/github-integration.md, Issue #87) ──
  //
  // A repository with no PAT is still distributable when the hub itself is
  // logged into that host's CLI — the same fallback GitHubClient/GitLabClient
  // have always applied to issue/PR calls.

  it('reports ok with credentialSource cli when the repository has no PAT but the hub CLI is logged in', async () => {
    mockedResolveCliTokens.mockResolvedValue(() => 'gho_cli');
    const base = makeOpts();
    const opts = makeOpts({
      projectRepo: { ...base.projectRepo, findRepositoryCredentialsByIds: vi.fn(() => [makeCredential({ credentialStatus: 'absent', token: null })]) },
    });
    const res = await getServers(opts);
    const [row] = res.json();
    expect(row.distributionPrerequisite).toEqual({ status: 'ok', stage: null, credentialSource: 'cli' });
    // The credential VALUE never crosses the API boundary.
    expect(res.body).not.toContain('gho_cli');
  });

  it('resolves the CLI token for the repository\'s own provider/host, once, only for repositories lacking a PAT', async () => {
    const base = makeOpts();
    const rows = [
      makeProjectServer({ serverName: 'iso-0', distributionRepositoryId: 1 }),
      makeProjectServer({ serverName: 'iso-1', distributionRepositoryId: 2 }),
    ];
    const servers = [makeServer({ name: 'iso-0' }), makeServer({ name: 'iso-1' })];
    const opts = makeOpts({
      projectServerRepo: { ...base.projectServerRepo, findByProject: vi.fn(() => rows) },
      serverRepo: { ...base.serverRepo, findMetaByNames: vi.fn((names: string[]) => servers.filter((s) => names.includes(s.name)).map(toMeta)) },
      projectRepo: {
        ...base.projectRepo,
        findRepositoryCredentialsByIds: vi.fn(() => [
          makeCredential({ id: 1, url: 'https://ghe.example.com/acme/widgets.git', credentialStatus: 'absent', token: null }),
          makeCredential({ id: 2 }),
        ]),
      },
    });
    await getServers(opts);
    expect(mockedResolveCliTokens).toHaveBeenCalledTimes(1);
    const targets = mockedResolveCliTokens.mock.calls[0][0] as CliTokenTarget[];
    // Only the PAT-less repository's host — repository 2 has a PAT, so its
    // host is never asked about (no wasted CLI process).
    expect([...targets]).toEqual([{ provider: 'github', host: 'ghe.example.com' }]);
  });

  it('asks for no CLI targets at all when every referenced repository has a PAT', async () => {
    await getServers(makeOpts());
    expect([...(mockedResolveCliTokens.mock.calls[0][0] as CliTokenTarget[])]).toEqual([]);
  });

  // Guards the reason the lookup is resolved up front and handed in: the
  // per-row check is synchronous, and a synchronous `gh` invocation on this
  // frequently-polled read-only listing would block the event loop for the
  // CLI's timeout. The route must reach the CLI ONLY through the async
  // resolver.
  it('never resolves CLI credentials synchronously from this route', async () => {
    const base = makeOpts();
    const opts = makeOpts({
      projectRepo: { ...base.projectRepo, findRepositoryCredentialsByIds: vi.fn(() => [makeCredential({ credentialStatus: 'absent', token: null })]) },
    });
    // The synchronous resolver is stubbed to throw: reaching it at all would
    // fail this request outright, not merely record a call.
    const res = await getServers(opts);
    expect(res.statusCode).toBe(200);
    expect(mockedGetCliTokenSync).not.toHaveBeenCalled();
    expect(mockedResolveCliTokens).toHaveBeenCalledTimes(1);
  });

  it('reports service_not_wired when FetchDistributionService is unavailable', async () => {
    const [row] = (await getServers(makeOpts({ fetchDistributionService: null }))).json();
    expect(row.distributionPrerequisite).toEqual({ status: 'failed', stage: 'service_not_wired', credentialSource: null });
  });

  it('reports not_required for a local server', async () => {
    const base = makeOpts();
    const opts = makeOpts({
      serverRepo: { ...base.serverRepo, findMetaByNames: vi.fn(() => [toMeta(makeServer({ type: 'local', isolationIntent: false }))]) },
    });
    const [row] = (await getServers(opts)).json();
    expect(row.distributionRequired).toBe(false);
    expect(row.distributionPrerequisite).toEqual({ status: 'not_required', stage: null, credentialSource: null });
  });

  it('reports unknown (never a healthy-looking default) when the referenced servers row no longer exists', async () => {
    const base = makeOpts();
    const opts = makeOpts({ serverRepo: { ...base.serverRepo, findMetaByNames: vi.fn(() => []) } });
    const [row] = (await getServers(opts)).json();
    expect(row.distributionRequired).toBeNull();
    expect(row.distributionPrerequisite).toEqual({ status: 'unknown', stage: null, credentialSource: null });
  });

  it('matches distribution_state on BOTH server name and repository id (a row for another server is not this server\'s record)', async () => {
    const opts = makeOpts({
      distributionStateRepo: {
        upsert: vi.fn(), deleteByServer: vi.fn(), find: vi.fn(() => null),
        findManyByRepositoryIds: vi.fn(() => [{ serverName: 'some-other-server', repositoryId: 1, lastDistributedSha: 'b'.repeat(40), bundleType: 'full' as const, distributedAt: '2026-08-30T10:00:00Z' }]),
      },
    });
    const [row] = (await getServers(opts)).json();
    expect(row.lastDistribution).toBeNull();
  });

  it('issues a constant number of queries even when every project server points at a DIFFERENT repository (no N+1)', async () => {
    const servers = Array.from({ length: 6 }, (_, i) => makeServer({ name: `iso-${i}` }));
    // Repositories 1/2/3 cycled across 6 servers: 3 distinct ids, 6 rows.
    const rows = servers.map((s, i) => makeProjectServer({ serverName: s.name, distributionRepositoryId: (i % 3) + 1 }));
    const base = makeOpts();
    const findMetaByNames = vi.fn((names: string[]) => servers.filter((s) => names.includes(s.name)).map(toMeta));
    const findManyByRepositoryIds = vi.fn(() => []);
    const findRepositoryCredentialsByIds = vi.fn((ids: number[]) => ids.map((id) => makeCredential({ id })));
    const opts = makeOpts({
      projectServerRepo: { ...base.projectServerRepo, findByProject: vi.fn(() => rows) },
      projectRepo: { ...base.projectRepo, findRepositoryCredentialsByIds },
      serverRepo: { ...base.serverRepo, findMetaByNames },
      distributionStateRepo: { upsert: vi.fn(), deleteByServer: vi.fn(), find: vi.fn(() => null), findManyByRepositoryIds },
    });
    const body = (await getServers(opts)).json();
    expect(body).toHaveLength(6);
    expect(body.every((r: { distributionPrerequisite: { status: string } }) => r.distributionPrerequisite.status === 'ok')).toBe(true);
    expect(findMetaByNames).toHaveBeenCalledTimes(1);
    expect(findMetaByNames).toHaveBeenCalledWith(servers.map((s) => s.name));
    expect(findManyByRepositoryIds).toHaveBeenCalledTimes(1);
    expect(findManyByRepositoryIds).toHaveBeenCalledWith([1, 2, 3]);
    // ONE bulk credential read for all three distinct repositories — not one
    // per row, and not one per distinct id.
    expect(findRepositoryCredentialsByIds).toHaveBeenCalledTimes(1);
    expect(findRepositoryCredentialsByIds).toHaveBeenCalledWith([1, 2, 3]);
    // The per-row `find(serverName, repositoryId)` path must not be used here.
    expect(opts.distributionStateRepo.find).not.toHaveBeenCalled();
  });

  it('degrades ONLY the affected row (credential_unreadable) when one repository\'s credential cannot be decrypted — the listing still returns 200', async () => {
    const servers = [makeServer({ name: 'iso-0' }), makeServer({ name: 'iso-1' })];
    const rows = [
      makeProjectServer({ serverName: 'iso-0', distributionRepositoryId: 1 }),
      makeProjectServer({ serverName: 'iso-1', distributionRepositoryId: 2 }),
    ];
    const base = makeOpts();
    const opts = makeOpts({
      projectServerRepo: { ...base.projectServerRepo, findByProject: vi.fn(() => rows) },
      serverRepo: { ...base.serverRepo, findMetaByNames: vi.fn((names: string[]) => servers.filter((s) => names.includes(s.name)).map(toMeta)) },
      projectRepo: {
        ...base.projectRepo,
        findRepositoryCredentialsByIds: vi.fn(() => [
          makeCredential({ id: 1, credentialStatus: 'unreadable', token: null }),
          makeCredential({ id: 2 }),
        ]),
      },
    });
    const res = await getServers(opts);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].distributionPrerequisite).toEqual({ status: 'failed', stage: 'credential_unreadable', credentialSource: null });
    expect(body[1].distributionPrerequisite).toEqual({ status: 'ok', stage: null, credentialSource: 'repository' });
    expect(res.body).not.toContain('ghp_x');
  });

  // Third-party review of 2b1e59c9, Important finding: this route previously
  // did not read `servers` at all. Reading it via `findAll()` made ANY
  // server's undecryptable `agent_token` — including one belonging to a
  // completely unrelated project — 500 the whole listing. Wired through the
  // REAL SqliteServerRepository so the regression cannot come back through a
  // mock that never decrypts anything.
  it('returns 200 with correct verdicts even when an UNRELATED server has an undecryptable agent_token', async () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE servers (
        name TEXT PRIMARY KEY, type TEXT NOT NULL, host TEXT, agent_port INTEGER, agent_token TEXT,
        agent_version TEXT, ssh_host TEXT, mux_runtime TEXT DEFAULT 'system', ssh_host_fingerprint TEXT,
        isolation_intent INTEGER DEFAULT 0, isolation_verified_at TEXT, isolation_report TEXT,
        isolation_cleanup_report TEXT, created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    const insert = db.prepare('INSERT INTO servers (name, type, agent_token, isolation_intent) VALUES (?, ?, ?, ?)');
    insert.run('iso-1', 'agent', null, 1);
    // Belongs to no project in this test — its broken credential must not
    // matter at all here.
    insert.run('someone-elses-server', 'agent', 'v1.corrupted', 1);
    const realServerRepo = new SqliteServerRepository(db as unknown as SqliteDatabase);
    // Sanity: the eager path really does blow up on this table.
    expect(() => realServerRepo.findAll()).toThrow();

    const res = await getServers(makeOpts({ serverRepo: realServerRepo }));

    expect(res.statusCode).toBe(200);
    const [row] = res.json();
    expect(row.serverName).toBe('iso-1');
    expect(row.distributionRequired).toBe(true);
    expect(row.distributionPrerequisite).toEqual({ status: 'ok', stage: null, credentialSource: 'repository' });
  });

  it('returns 200 when the project\'s OWN server has an undecryptable agent_token (the credential is irrelevant to this verdict)', async () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE servers (
        name TEXT PRIMARY KEY, type TEXT NOT NULL, host TEXT, agent_port INTEGER, agent_token TEXT,
        agent_version TEXT, ssh_host TEXT, mux_runtime TEXT DEFAULT 'system', ssh_host_fingerprint TEXT,
        isolation_intent INTEGER DEFAULT 0, isolation_verified_at TEXT, isolation_report TEXT,
        isolation_cleanup_report TEXT, created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.prepare('INSERT INTO servers (name, type, agent_token, isolation_intent) VALUES (?, ?, ?, ?)')
      .run('iso-1', 'agent', 'v1.corrupted', 1);
    const res = await getServers(makeOpts({ serverRepo: new SqliteServerRepository(db as unknown as SqliteDatabase) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].distributionPrerequisite).toEqual({ status: 'ok', stage: null, credentialSource: 'repository' });
    expect(res.body).not.toContain('v1.corrupted');
  });

  it('still 404s for an unknown project', async () => {
    const base = makeOpts();
    const opts = makeOpts({ projectRepo: { ...base.projectRepo, findById: vi.fn(() => null) } });
    const res = await getServers(opts);
    expect(res.statusCode).toBe(404);
  });
});
