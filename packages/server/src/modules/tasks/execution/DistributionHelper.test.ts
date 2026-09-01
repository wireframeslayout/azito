import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveExecutionRepositoryEntry, isDistributionRequired, isDistributionRequiredButRepositoryUnresolved, shouldClearRecordedDistributionRepository, checkDistributionPrerequisites, performDistribution } from './DistributionHelper';
import type { CheckDistributionPrerequisitesParams, DistributionRepositoryLookup, PerformDistributionParams } from './DistributionHelper';
import type { FetchDistributionService } from '../../git/hub-transfer/FetchDistributionService';
import type { ServerConfig } from '../../servers/Server';
import type { ProjectDetail, ProjectRepository, ProjectRepositoryWithToken } from '../../projects/Project';
import type { ProjectServer } from '../../projects/ProjectServer';
import type { IDistributionStateRepository } from '../../git/hub-transfer/types';
import { getCliToken, NO_CLI_TOKEN, type CliTokenLookup } from '../../git/providers/cliToken';

// The hub's own `gh`/`glab` login must never be consulted for real from a
// unit test (the result would depend on whoever is logged in on the machine
// running it), so the async resolver is stubbed. Everything else in the
// module (NO_CLI_TOKEN, the cache) stays real.
vi.mock('../../git/providers/cliToken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/providers/cliToken')>();
  return { ...actual, getCliToken: vi.fn(async () => null) };
});
const mockedGetCliToken = vi.mocked(getCliToken);

beforeEach(() => {
  mockedGetCliToken.mockReset();
  mockedGetCliToken.mockResolvedValue(null);
});

/** A CLI-token lookup that answers `token` for every host. */
function cliTokenFor(token: string | null): CliTokenLookup {
  return () => token;
}

// Issue #87 13th-round review, Important finding: the distribution target
// (`projectServer.distributionRepositoryId`) and the repository push/PR/
// notarization actually use used to disagree — this function is the single
// resolution point both `performDistribution` (via `isDistributionRequired`)
// and every downstream targeting decision (PhaseLoopRunner's pushing probe/
// notary, ExecuteTaskUseCase's final-git-info/isPushCompleted paths,
// ExecutionManifest's approval fingerprint) must now share.

const repoA: ProjectRepository = { id: 1, name: 'A', url: 'https://github.com/acme/repo-a.git', provider: 'github', owner: 'acme', repoName: 'repo-a', hasToken: true };
const repoB: ProjectRepository = { id: 2, name: 'B', url: 'https://github.com/acme/repo-b.git', provider: 'github', owner: 'acme', repoName: 'repo-b', hasToken: true };

function makeProject(repositories: ProjectRepository[]): Pick<ProjectDetail, 'repositories'> {
  return { repositories };
}

function makeProjectServer(overrides: Partial<Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'>>): Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> {
  return { distributeCode: false, distributionRepositoryId: null, ...overrides };
}

function makeAgentServer(overrides: Partial<Pick<ServerConfig, 'type' | 'isolationIntent'>> = {}): Pick<ServerConfig, 'type' | 'isolationIntent'> {
  return { type: 'agent', isolationIntent: false, ...overrides };
}

describe('resolveExecutionRepositoryEntry', () => {
  it('resolves the distributionRepositoryId target (repo B) when distribute_code is on for this project/server', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({ distributeCode: true, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoB.id);
  });

  it('resolves the distributionRepositoryId target (repo B) when the server carries isolationIntent, even with distribute_code off', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer({ isolationIntent: true }),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoB.id);
  });

  it('falls back to repositories[0] (A) when distribution is not required for this project/server (no distributeCode, no isolationIntent)', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoA.id);
  });

  it('falls back to repositories[0] (A) for a local server, even when distributionRepositoryId is set (local is never a distribution target)', () => {
    const result = resolveExecutionRepositoryEntry(
      { type: 'local', isolationIntent: false },
      makeProjectServer({ distributeCode: true, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoA.id);
  });

  // Issue #87 14th-round review, Important finding: these two cases used to
  // fall back to repositories[0] (A) even though distribution IS required —
  // reintroducing the exact push/PR/notary-target mismatch this function
  // exists to prevent. Both must now return null instead.

  it('returns null (does NOT fall back to repositories[0]) when distribution is active but no distributionRepositoryId is configured', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer({ isolationIntent: true }),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: null }),
      makeProject([repoA, repoB]),
    );
    expect(result).toBeNull();
  });

  it('returns null (does NOT fall back to repositories[0]) when distribution is active but the configured distributionRepositoryId no longer exists on the project', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer({ isolationIntent: true }),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: 999 }),
      makeProject([repoA, repoB]),
    );
    expect(result).toBeNull();
  });

  it('returns null when distribute_code is on (no isolationIntent) but no distributionRepositoryId is configured', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({ distributeCode: true, distributionRepositoryId: null }),
      makeProject([repoA, repoB]),
    );
    expect(result).toBeNull();
  });

  it('returns null when the project has no registered repository at all', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({}),
      makeProject([]),
    );
    expect(result).toBeNull();
  });

  it('returns null when server is null (no resolvable server) and there is no repository to fall back to', () => {
    const result = resolveExecutionRepositoryEntry(null, makeProjectServer({}), makeProject([]));
    expect(result).toBeNull();
  });

  it('returns null when project is null', () => {
    const result = resolveExecutionRepositoryEntry(makeAgentServer(), makeProjectServer({}), null);
    expect(result).toBeNull();
  });

  it('returns null when projectServer is null and distribution is not otherwise required', () => {
    const result = resolveExecutionRepositoryEntry(makeAgentServer(), null, makeProject([]));
    expect(result).toBeNull();
  });
});

// Issue #87 review (forge/87-mirror follow-up), Important finding 2: the
// previous fix (ExecuteTaskUseCase.isPushCompleted's fail-closed check) was
// applied on only one of the two push-completion paths — PhaseLoopRunner's
// pushing-phase probe kept the old behavior, silently accepting a SHA-only
// match when the distributed repository could not be resolved. This
// function is now the single source both paths call, so a future fix here
// automatically covers both.
describe('isDistributionRequiredButRepositoryUnresolved', () => {
  it('is true when distribution is required (distributeCode on) and no repository was resolved', () => {
    const distributionRequired = isDistributionRequired(makeAgentServer({ isolationIntent: false }), makeProjectServer({ distributeCode: true }));
    expect(isDistributionRequiredButRepositoryUnresolved(distributionRequired, null)).toBe(true);
  });

  it('is true when distribution is required (isolationIntent) and no repository was resolved', () => {
    const distributionRequired = isDistributionRequired(makeAgentServer({ isolationIntent: true }), makeProjectServer({ distributeCode: false }));
    expect(isDistributionRequiredButRepositoryUnresolved(distributionRequired, null)).toBe(true);
  });

  it('is false when distribution is required but a repository WAS resolved', () => {
    const distributionRequired = isDistributionRequired(makeAgentServer({ isolationIntent: true }), makeProjectServer({ distributeCode: false }));
    expect(isDistributionRequiredButRepositoryUnresolved(distributionRequired, repoB)).toBe(false);
  });

  it('is false when distribution is not required, even with no repository resolved (never-registered-a-repository fallback stays intact)', () => {
    const distributionRequired = isDistributionRequired(makeAgentServer({ isolationIntent: false }), makeProjectServer({ distributeCode: false }));
    expect(isDistributionRequiredButRepositoryUnresolved(distributionRequired, null)).toBe(false);
  });

  it('is false for a local server regardless of projectServer/repo (local is never a distribution target)', () => {
    const distributionRequired = isDistributionRequired({ type: 'local', isolationIntent: false }, makeProjectServer({ distributeCode: true }));
    expect(isDistributionRequiredButRepositoryUnresolved(distributionRequired, null)).toBe(false);
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 2 (second
  // round): this function must trust the caller-computed flag, never
  // re-derive it — so a stale `distributionRequired=true` locked from BEFORE
  // a `distributeCode` toggle was flipped off must still fail closed here,
  // exactly like a stale locked `distributionRepoEntry` still targets the
  // repository it was locked to (DistributionHelper's module doc comment).
  it('stays fail-closed on a locked distributionRequired=true even when the CURRENT projectServer would now compute false', () => {
    // Simulates: run started with distributeCode=true (distributionRequired
    // locked true), then the toggle was flipped off AND the locked
    // repository deleted (repo=null) before this check runs.
    const distributionRequired = true;
    const currentlyComputedFresh = isDistributionRequired(makeAgentServer({ isolationIntent: false }), makeProjectServer({ distributeCode: false }));
    expect(currentlyComputedFresh).toBe(false); // sanity: the drift this test guards against
    expect(isDistributionRequiredButRepositoryUnresolved(distributionRequired, null)).toBe(true);
  });
});

describe('shouldClearRecordedDistributionRepository (Issue #87 review, forge/87-mirror follow-up, Important finding 3)', () => {
  function mockDistributionStateRepo(overrides: Partial<IDistributionStateRepository> = {}): IDistributionStateRepository {
    return {
      upsert: vi.fn(),
      deleteByServer: vi.fn(),
      find: vi.fn(() => null),
      findManyByRepositoryIds: vi.fn(() => []),
      ...overrides,
    };
  }

  it('returns false (keep the record) when nothing is recorded yet', () => {
    const repo = mockDistributionStateRepo();
    expect(shouldClearRecordedDistributionRepository(repo, 'server-a', null)).toBe(false);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('returns false (keep the record) when a distribution_state row exists for this server and the recorded repository — same server, same source reused', () => {
    const repo = mockDistributionStateRepo({
      find: vi.fn((serverName: string, repositoryId: number) =>
        serverName === 'server-a' && repositoryId === 7
          ? { lastDistributedSha: 'a'.repeat(40), bundleType: 'full' as const, distributedAt: '2026-01-01T00:00:00Z' }
          : null),
    });
    expect(shouldClearRecordedDistributionRepository(repo, 'server-a', 7)).toBe(false);
  });

  it('returns true (clear the record) when no distribution_state row exists for this server and the recorded repository — e.g. the task moved to a different server', () => {
    const repo = mockDistributionStateRepo({ find: vi.fn(() => null) });
    expect(shouldClearRecordedDistributionRepository(repo, 'server-b', 7)).toBe(true);
  });

  it('queries by the CURRENT run\'s server name, not some other value', () => {
    const find = vi.fn(() => null);
    const repo = mockDistributionStateRepo({ find });
    shouldClearRecordedDistributionRepository(repo, 'server-a', 7);
    expect(find).toHaveBeenCalledWith('server-a', 7);
  });
});

// ── checkDistributionPrerequisites (Issue #87 配信状態の可視化) ──
//
// The remote-free half of `performDistribution`, extracted so GET
// /api/projects/:id/servers can render the same verdict without executing a
// task. Every stage below is reachable BEFORE any transport is obtained.

describe('checkDistributionPrerequisites', () => {
  const tokenedRepo: ProjectRepositoryWithToken = { id: repoB.id, name: 'B', url: repoB.url, provider: 'github', owner: 'acme', repoName: 'repo-b', token: 'ghp_x' };

  function makeLookup(result?: DistributionRepositoryLookup) {
    return vi.fn((_rid: number): DistributionRepositoryLookup => result ?? { status: 'ok', repo: tokenedRepo, token: 'ghp_x' });
  }

  const service = {} as FetchDistributionService;

  function check(overrides: Partial<CheckDistributionPrerequisitesParams> = {}) {
    return checkDistributionPrerequisites({
      server: makeAgentServer({ isolationIntent: true }),
      projectServer: makeProjectServer({ distributionRepositoryId: repoB.id }),
      project: makeProject([repoA, repoB]),
      workingDir: '/work/dir',
      lookupRepository: makeLookup(),
      cliToken: NO_CLI_TOKEN,
      fetchDistributionService: service,
      ...overrides,
    });
  }

  it('returns { required: false } for a local server (never a distribution target)', () => {
    expect(check({ server: { type: 'local', isolationIntent: false } })).toEqual({ required: false });
  });

  it('returns { required: false } for an agent server with neither isolationIntent nor distributeCode', () => {
    expect(check({ server: makeAgentServer(), projectServer: makeProjectServer({ distributionRepositoryId: repoB.id }) })).toEqual({ required: false });
  });

  it('fails with service_not_wired when FetchDistributionService is absent', () => {
    const result = check({ fetchDistributionService: null });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'service_not_wired' });
  });

  it('fails with no_working_dir when no working directory is configured', () => {
    expect(check({ workingDir: null })).toMatchObject({ required: true, ok: false, stage: 'no_working_dir' });
  });

  it('fails with no_distribution_repository when distributionRepositoryId is unset (the project-wizard "use an existing directory" gap)', () => {
    const result = check({ projectServer: makeProjectServer({ distributeCode: true, distributionRepositoryId: null }) });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'no_distribution_repository' });
  });

  it('fails with distribution_repository_not_found when the configured id no longer exists on the project', () => {
    const result = check({ projectServer: makeProjectServer({ distributionRepositoryId: 999 }) });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'distribution_repository_not_found' });
  });

  it('fails with no_token when the lookup reports no credential (row gone, or token absent)', () => {
    const result = check({ lookupRepository: makeLookup({ status: 'no_token' }) });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'no_token' });
  });

  it('fails with credential_unreadable when the lookup reports an undecryptable credential', () => {
    const result = check({ lookupRepository: makeLookup({ status: 'unreadable' }) });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'credential_unreadable' });
  });

  it('never embeds the credential itself in the credential_unreadable message', () => {
    const result = check({ lookupRepository: makeLookup({ status: 'unreadable' }) });
    if (result.required === false || result.ok) throw new Error('expected a prerequisite failure');
    expect(result.message).not.toContain('ghp_');
  });

  it('fails with identity_unresolvable when the repository URL cannot be normalized', () => {
    const result = check({ lookupRepository: makeLookup({ status: 'ok', repo: { ...tokenedRepo, url: 'not a url' }, token: 'ghp_x' }) });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'identity_unresolvable' });
  });

  it('never leaks the repository URL through the identity_unresolvable stage value itself (only the internal message carries detail)', () => {
    const result = check({ lookupRepository: makeLookup({ status: 'ok', repo: { ...tokenedRepo, url: 'not a url' }, token: 'ghp_x' }) });
    if (result.required === false || result.ok) throw new Error('expected a prerequisite failure');
    expect(result.stage).toBe('identity_unresolvable');
    expect(result.message).toContain('url_not_normalizable');
  });

  it('returns ok with the resolved repositoryId, workingDir, token, identity and service when every prerequisite passes', () => {
    const result = check();
    if (result.required === false || !result.ok) throw new Error('expected prerequisites to pass');
    expect(result.repositoryId).toBe(repoB.id);
    expect(result.workingDir).toBe('/work/dir');
    expect(result.token).toBe('ghp_x');
    expect(result.credentialSource).toBe('repository');
    expect(result.identity.httpsUrl).toBe('https://github.com/acme/repo-b.git');
    expect(result.fetchDistributionService).toBe(service);
  });

  it('passes for a distributeCode server without isolationIntent too', () => {
    const result = check({ server: makeAgentServer(), projectServer: makeProjectServer({ distributeCode: true, distributionRepositoryId: repoB.id }) });
    expect(result).toMatchObject({ required: true, ok: true, repositoryId: repoB.id });
  });

  it('does not look the repository up at all when distribution is not required (no wasted query/decryption for the common case)', () => {
    const lookupRepository = makeLookup();
    check({ server: { type: 'local', isolationIntent: false }, lookupRepository });
    expect(lookupRepository).not.toHaveBeenCalled();
  });

  it('looks the repository up exactly once, by the resolved target id', () => {
    const lookupRepository = makeLookup();
    check({ lookupRepository });
    expect(lookupRepository).toHaveBeenCalledTimes(1);
    expect(lookupRepository).toHaveBeenCalledWith(repoB.id);
  });

  // ── Two-stage token resolution (docs/ja/github-integration.md) ──

  it('passes on the hub CLI token when the repository has no PAT, reporting credentialSource cli', () => {
    const result = check({
      lookupRepository: makeLookup({ status: 'no_token', repo: tokenedRepo }),
      cliToken: cliTokenFor('gho_cli'),
    });
    if (result.required === false || !result.ok) throw new Error('expected prerequisites to pass');
    expect(result.token).toBe('gho_cli');
    expect(result.credentialSource).toBe('cli');
  });

  it('asks the CLI lookup for the repository\'s own canonical provider/host, never a default', () => {
    const cliToken = vi.fn(() => 'gho_cli');
    check({
      lookupRepository: makeLookup({ status: 'no_token', repo: { ...tokenedRepo, url: 'https://ghe.example.com/acme/repo-b.git' } }),
      cliToken,
    });
    expect(cliToken).toHaveBeenCalledWith({ provider: 'github', host: 'ghe.example.com' });
  });

  it('prefers the repository PAT over the hub CLI token and never consults the CLI lookup at all', () => {
    const cliToken = vi.fn(() => 'gho_cli');
    const result = check({ cliToken });
    if (result.required === false || !result.ok) throw new Error('expected prerequisites to pass');
    expect(result.token).toBe('ghp_x');
    expect(result.credentialSource).toBe('repository');
    expect(cliToken).not.toHaveBeenCalled();
  });

  it('fails with no_token when neither a PAT nor a CLI token is available', () => {
    const result = check({
      lookupRepository: makeLookup({ status: 'no_token', repo: tokenedRepo }),
      cliToken: cliTokenFor(null),
    });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'no_token' });
  });

  it('fails with no_token (no CLI lookup possible) when the repository row itself is gone', () => {
    const cliToken = vi.fn(() => 'gho_cli');
    const result = check({ lookupRepository: makeLookup({ status: 'no_token' }), cliToken });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'no_token' });
    expect(cliToken).not.toHaveBeenCalled();
  });

  it('never consults the CLI for an undecryptable credential (that is a broken PAT, not a missing one)', () => {
    const cliToken = vi.fn(() => 'gho_cli');
    const result = check({ lookupRepository: makeLookup({ status: 'unreadable' }), cliToken });
    expect(result).toMatchObject({ required: true, ok: false, stage: 'credential_unreadable' });
    expect(cliToken).not.toHaveBeenCalled();
  });

  // The function is synchronous and rendered per row by the frequently
  // polled GET /api/projects/:id/servers, so it must never reach for a
  // credential itself — the CLI lookup it is handed is already resolved.
  it('resolves entirely from its arguments: no CLI process is spawned, even when no PAT exists', () => {
    check({ lookupRepository: makeLookup({ status: 'no_token', repo: tokenedRepo }), cliToken: cliTokenFor('gho_cli') });
    expect(mockedGetCliToken).not.toHaveBeenCalled();
  });
});

// `performDistribution` now delegates its entire prerequisite phase to
// `checkDistributionPrerequisites`. These assert the observable contract is
// byte-identical to the pre-extraction behavior: same stage, same message,
// and — critically — the transport is never obtained and `distribute()` is
// never called for any prerequisite failure.
describe('performDistribution (prerequisite phase unchanged after extraction)', () => {
  function makeHarness(overrides: Partial<PerformDistributionParams> = {}) {
    const distribute = vi.fn(async (_params: { onBeforeWorkingDirChange?: () => void }) => ({ status: 'distributed' as const, sha: 'b'.repeat(40), bundleType: 'full' as const, localBranchSynced: true }));
    const getTransport = vi.fn(() => ({} as never));
    const params: PerformDistributionParams = {
      server: { type: 'agent', isolationIntent: true } as ServerConfig,
      projectServer: makeProjectServer({ distributionRepositoryId: repoB.id }),
      project: makeProject([repoA, repoB]),
      workingDir: '/work/dir',
      baseBranch: 'main',
      taskBranch: null,
      transportFactory: { getTransport } as unknown as PerformDistributionParams['transportFactory'],
      projectRepo: { findRepositoryById: vi.fn(() => ({ id: repoB.id, name: 'B', url: repoB.url, provider: 'github' as const, owner: 'acme', repoName: 'repo-b', token: 'ghp_x' })) } as unknown as PerformDistributionParams['projectRepo'],
      fetchDistributionService: { distribute } as unknown as FetchDistributionService,
      ...overrides,
    };
    return { params, distribute, getTransport };
  }

  it('returns { required: false } without obtaining a transport when distribution is not required', async () => {
    const { params, getTransport, distribute } = makeHarness({ server: { type: 'local', isolationIntent: false } as ServerConfig });
    await expect(performDistribution(params)).resolves.toEqual({ required: false });
    expect(getTransport).not.toHaveBeenCalled();
    expect(distribute).not.toHaveBeenCalled();
  });

  it.each([
    ['service_not_wired', { fetchDistributionService: null }, 'Fetch distribution is required (server isolation intent or project distribute_code) but FetchDistributionService is not wired'],
    ['no_working_dir', { workingDir: null }, 'Fetch distribution is required (server isolation intent or project distribute_code) but no working directory is configured for this task/server'],
    ['no_distribution_repository', { projectServer: makeProjectServer({ distributionRepositoryId: null, distributeCode: true }) }, 'Fetch distribution is required but no distribution target repository is configured for this project server. Select one in Settings → Servers for this project/server pairing.'],
    ['distribution_repository_not_found', { projectServer: makeProjectServer({ distributionRepositoryId: 999 }) }, 'Fetch distribution is required but the configured distribution target repository no longer exists on this project'],
  ] as const)('fails with %s (verbatim message) and never obtains a transport', async (stage, overrides, message) => {
    const { params, getTransport, distribute } = makeHarness(overrides as Partial<PerformDistributionParams>);
    await expect(performDistribution(params)).resolves.toEqual({ required: true, ok: false, stage, message });
    expect(getTransport).not.toHaveBeenCalled();
    expect(distribute).not.toHaveBeenCalled();
  });

  it('fails with no_token (verbatim message) and never obtains a transport', async () => {
    const { params, getTransport, distribute } = makeHarness({
      projectRepo: { findRepositoryById: vi.fn(() => ({ id: repoB.id, name: 'B', url: repoB.url, provider: 'github' as const, owner: 'acme', repoName: 'repo-b', token: null })) } as unknown as PerformDistributionParams['projectRepo'],
    });
    await expect(performDistribution(params)).resolves.toEqual({
      required: true, ok: false, stage: 'no_token',
      message: 'Fetch distribution is required but the repository has no token configured',
    });
    expect(getTransport).not.toHaveBeenCalled();
    expect(distribute).not.toHaveBeenCalled();
  });

  it('fails with identity_unresolvable (verbatim message, including the reason) and never obtains a transport', async () => {
    const { params, getTransport } = makeHarness({
      projectRepo: { findRepositoryById: vi.fn(() => ({ id: repoB.id, name: 'B', url: 'not a url', provider: 'github' as const, owner: 'acme', repoName: 'repo-b', token: 'ghp_x' })) } as unknown as PerformDistributionParams['projectRepo'],
    });
    await expect(performDistribution(params)).resolves.toEqual({
      required: true, ok: false, stage: 'identity_unresolvable',
      message: 'Fetch distribution is required but the repository URL could not be normalized to a canonical identity: url_not_normalizable',
    });
    expect(getTransport).not.toHaveBeenCalled();
  });

  it('distributes with the resolved identity/token/workingDir and reports the repositoryId when prerequisites pass', async () => {
    const { params, distribute, getTransport } = makeHarness();
    const onBeforeDistribute = vi.fn();
    const result = await performDistribution({ ...params, onBeforeDistribute });
    expect(getTransport).toHaveBeenCalledTimes(1);
    expect(distribute).toHaveBeenCalledWith(expect.objectContaining({
      token: 'ghp_x',
      branch: 'main',
      workingDir: '/work/dir',
      repositoryId: repoB.id,
      repoIdentity: expect.objectContaining({ httpsUrl: 'https://github.com/acme/repo-b.git' }),
    }));
    expect(result).toEqual({ required: true, ok: true, distStatus: 'distributed', sha: 'b'.repeat(40), bundleType: 'full', localBranchSynced: true, repositoryId: repoB.id });
    // Fired by distribute() itself, never by performDistribution — the mock
    // above never invokes onBeforeWorkingDirChange.
    expect(onBeforeDistribute).not.toHaveBeenCalled();
    distribute.mock.calls[0][0].onBeforeWorkingDirChange?.();
    expect(onBeforeDistribute).toHaveBeenCalledWith(repoB.id);
  });

  it('distributes on the hub CLI token when the repository has no PAT of its own', async () => {
    mockedGetCliToken.mockResolvedValue('gho_cli');
    const { params, distribute } = makeHarness({
      projectRepo: { findRepositoryById: vi.fn(() => ({ id: repoB.id, name: 'B', url: repoB.url, provider: 'github' as const, owner: 'acme', repoName: 'repo-b', token: null })) } as unknown as PerformDistributionParams['projectRepo'],
    });
    const result = await performDistribution(params);
    expect(mockedGetCliToken).toHaveBeenCalledWith({ provider: 'github', host: 'github.com' });
    expect(distribute).toHaveBeenCalledWith(expect.objectContaining({ token: 'gho_cli' }));
    expect(result).toMatchObject({ required: true, ok: true });
  });

  it('never asks the CLI when the repository has a PAT, and reads/decrypts the repository row only once', async () => {
    const findRepositoryById = vi.fn(() => ({ id: repoB.id, name: 'B', url: repoB.url, provider: 'github' as const, owner: 'acme', repoName: 'repo-b', token: 'ghp_x' }));
    const { params } = makeHarness({ projectRepo: { findRepositoryById } as unknown as PerformDistributionParams['projectRepo'] });
    await performDistribution(params);
    expect(mockedGetCliToken).not.toHaveBeenCalled();
    expect(findRepositoryById).toHaveBeenCalledTimes(1);
  });

  it('never asks the CLI when distribution is not required at all', async () => {
    const { params } = makeHarness({ server: { type: 'local', isolationIntent: false } as ServerConfig });
    await performDistribution(params);
    expect(mockedGetCliToken).not.toHaveBeenCalled();
  });

  it('reports distribute_failed with the service error verbatim', async () => {
    const { params } = makeHarness({
      fetchDistributionService: { distribute: vi.fn(async () => ({ status: 'failed' as const, error: 'boom' })) } as unknown as FetchDistributionService,
    });
    await expect(performDistribution(params)).resolves.toEqual({ required: true, ok: false, stage: 'distribute_failed', message: 'Fetch distribution failed: boom' });
  });

  it('reports stale_local_branch (naming the resolved working directory) when the task branch is the distributed branch and the local ref could not be advanced', async () => {
    const { params } = makeHarness({
      taskBranch: 'main',
      fetchDistributionService: { distribute: vi.fn(async () => ({ status: 'distributed' as const, sha: 'c'.repeat(40), bundleType: 'full' as const, localBranchSynced: false })) } as unknown as FetchDistributionService,
    });
    const result = await performDistribution(params);
    if (result.required === false || result.ok) throw new Error('expected stale_local_branch');
    expect(result.stage).toBe('stale_local_branch');
    expect(result.message).toContain('the local branch "main" in /work/dir could not be updated');
  });
});
