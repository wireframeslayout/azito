import type { ServerConfig } from '../../servers/Server';
import type { ProjectDetail, ProjectRepository, ProjectRepositoryWithToken } from '../../projects/Project';
import type { ProjectServer } from '../../projects/ProjectServer';
import type { IProjectRepository } from '../../projects/Project';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { resolveCanonicalRepositoryIdentity, type CanonicalRepositoryIdentity } from '../../git/resolveCanonicalRepositoryIdentity';
import { normalizeBranchRef } from '../../git/assertSafeGitArgs';
import { getCliToken, NO_CLI_TOKEN, type CliTokenLookup } from '../../git/providers/cliToken';
import type { FetchDistributionService } from '../../git/hub-transfer/FetchDistributionService';
import type { IDistributionStateRepository } from '../../git/hub-transfer/types';

/**
 * Shared by ExecuteTaskUseCase and TaskRestoreService (Issue #87 13th-round
 * review, Important finding 1): both entry points create a task window and
 * then (re)create its worktree from `workingDir`, so both need the exact
 * same "does this server/project need code distributed onto it, and is the
 * distribution actually possible" logic — an isolated server or a
 * `distribute_code` project server must never have its worktree recreated
 * from stale/absent local content just because a task happened to go
 * through restore() instead of execute().
 *
 * Deliberately stops at "run the prerequisite checks and the distribution
 * itself, return the outcome" — it does NOT touch task status, does NOT log,
 * and does NOT roll back the caller's tmux window/token. Those differ enough
 * between execute() (rollbackWindowAfterPostCreationFailure, several distinct
 * rollback reason strings) and restore() (its own try/catch around the whole
 * window+worktree span) that folding them in here would either lose
 * information the two callers actually use differently, or force one of them
 * to adopt behavior it doesn't have today. See each call site for how it
 * turns a `{ ok: false }` outcome into its own rollback + task status update.
 */

export type DistributionFailureStage =
  | 'service_not_wired'
  | 'no_working_dir'
  | 'no_distribution_repository'
  | 'distribution_repository_not_found'
  | 'no_token'
  | 'identity_unresolvable'
  | 'credential_unreadable'
  | 'distribute_failed'
  | 'stale_local_branch';

export type DistributionOutcome =
  | { required: false }
  | {
      required: true;
      ok: true;
      distStatus: 'distributed' | 'already_current';
      sha?: string;
      bundleType?: 'full' | 'incremental';
      localBranchSynced?: boolean;
      // The `project_repositories` id distribution actually pulled code
      // from (Issue #87 review follow-up, Important finding 1) — the
      // caller persists this onto `task.distributionRepositoryId` so a
      // LATER resume (which must never re-resolve the distribution target
      // from the project/project-server's THEN-current configuration —
      // the task's working directory already holds code from THIS
      // repository, not whatever the config points at by the time resume
      // runs) can use the value that was actually true at distribution
      // time.
      repositoryId: number;
    }
  | { required: true; ok: false; stage: DistributionFailureStage; message: string };

/**
 * Whether `server`/`projectServer` requires fetch distribution before a
 * worktree can be created on it — a property of server/project
 * configuration alone, never of whether a working directory happens to be
 * set (Issue #87 review, forge/87-mirror follow-up, Important finding 2).
 */
export function isDistributionRequired(
  server: Pick<ServerConfig, 'type' | 'isolationIntent'>,
  projectServer: Pick<ProjectServer, 'distributeCode'> | null,
): boolean {
  return server.type !== 'local' && !!(server.isolationIntent || projectServer?.distributeCode);
}

/**
 * Whether distribution must be treated as required for a RESUMED/CONTINUED
 * run — resumeStateMachine(), followUp()'s state-machine continuation, and
 * isPushCompleted() (Issue #87 review, forge/87-mirror follow-up, Important
 * finding 2, third round). `isDistributionRequired` alone answers "does the
 * CURRENT server/project-server configuration call for distribution" — the
 * right question for a FRESH execute() run deciding whether to distribute in
 * the first place, but the wrong one for a run that is only continuing/
 * verifying work a PAST execute()/restore() already did.
 *
 * A non-null `recordedRepositoryId` (`task.distributionRepositoryId`) is
 * itself proof that this task's working directory was populated by fetch
 * distribution, independent of whatever the project-server's `distributeCode`
 * toggle (or the server's `isolationIntent`) reads by the time the run
 * resumes: the working directory's actual contents don't change when an
 * operator flips that toggle or deletes the recorded repository, so
 * verification of what is ALREADY on disk must still be performed against
 * the repository distribution actually used — never silently downgraded to
 * a SHA-only match just because the current configuration no longer asks for
 * distribution. See `resolveRecordedDistributionRepositoryEntry`'s doc
 * comment for the matching rule on WHICH repository to resolve; this
 * function answers the companion question of WHETHER a repository must
 * resolve at all before the pushing phase may proceed.
 *
 * When `recordedRepositoryId` is null (the task predates this column, or its
 * originating run never went through distribution), this falls back to
 * `isDistributionRequired` unchanged — a live-config read is the only signal
 * available, exactly as before this column existed.
 */
export function isDistributionRequiredForContinuation(
  recordedRepositoryId: number | null | undefined,
  server: Pick<ServerConfig, 'type' | 'isolationIntent'>,
  projectServer: Pick<ProjectServer, 'distributeCode'> | null,
): boolean {
  return recordedRepositoryId != null || isDistributionRequired(server, projectServer);
}

/**
 * Resolves which `project.repositories` entry an actual run should treat as
 * THE repository — used for every downstream decision that follows from
 * "which repository did this run's code come from/go to" (push
 * verification, PR creation, hub push notarization, the approval manifest's
 * repository identity — Issue #87 13th-round review, Important finding).
 *
 * Deliberately mirrors `isDistributionRequired`'s condition rather than
 * re-deriving it: whenever fetch distribution is (or would be) active for
 * this server/project-server pairing, the ONLY repository this function may
 * return is the one named by `distributionRepositoryId` — that is the
 * repository whose code actually landed on the server, so every downstream
 * consumer must agree with `performDistribution`'s own choice
 * (DistributionHelper's module doc comment).
 *
 * Issue #87 review (14th round), Important finding: this function used to
 * fall through to `project.repositories[0]` whenever
 * `distributionRepositoryId` was unset OR named a repository that no longer
 * exists on the project — i.e. exactly the two situations where the
 * distributed repository is unknown or gone. That reintroduced the
 * distribution/push mismatch this function exists to prevent: delete
 * repository B after code was distributed from it, and every downstream
 * consumer (push verification, PR creation, hub notarization, the approval
 * manifest) would silently retarget repository A. When distribution is
 * required, this function now returns the resolved entry or `null` —
 * NEVER `project.repositories[0]` — so a caller that receives `null` here
 * knows the distributed repository could not be identified and must decide
 * for itself whether that is safe to proceed without (e.g. read-only PR
 * lookup) or must hard-fail (e.g. an actual push/notarization write).
 *
 * Falls back to `project.repositories[0]` ONLY when distribution is not
 * required at all (local server, or an agent/ssh server with neither
 * `isolationIntent` nor `distributeCode`) — so every project that has never
 * touched hub-代行 distribution keeps its pre-existing behavior unchanged.
 */
export function resolveExecutionRepositoryEntry(
  server: Pick<ServerConfig, 'type' | 'isolationIntent'> | null,
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null,
  project: Pick<ProjectDetail, 'repositories'> | null,
): ProjectRepository | null {
  if (server && isDistributionRequired(server, projectServer)) {
    const distributionRepositoryId = projectServer?.distributionRepositoryId ?? null;
    if (distributionRepositoryId == null) return null;
    return project?.repositories?.find((r) => r.id === distributionRepositoryId) ?? null;
  }
  return project?.repositories?.[0] ?? null;
}

/**
 * Whether push verification (and PR creation/verification/notarization) must
 * fail closed because distribution is required for this run but the
 * distributed repository could not be resolved (unset
 * `distributionRepositoryId`, or it names a repository that no longer exists
 * — see `resolveExecutionRepositoryEntry`'s doc comment for why that resolver
 * returns `null` rather than falling back to `project.repositories[0]` in
 * this exact situation).
 *
 * Extracted (Issue #87 review, forge/87-mirror follow-up, Important finding
 * 2) so `ExecuteTaskUseCase.isPushCompleted()` and `PhaseLoopRunner`'s
 * pushing-phase completion probe apply the SAME rule instead of each
 * hand-rolling their own copy — that duplication is exactly how the probe
 * side drifted out of sync with `isPushCompleted()`'s fix in the first
 * place. `PushVerifier.verifyPushCompleted()` treats a missing `repo` as "no
 * repository info to check against, skip PR verification, trust the SHA
 * match alone" — a fallback that only makes sense for a project that never
 * registered a repository at all. Reusing that fallback here (distribution
 * required but the target repository is unresolved) would silently accept
 * "push completed" without ever having checked the actual target repository
 * or its PR — so both callers must check this FIRST and refuse to call PR
 * creation/verification at all when it's true, treating the probe as
 * not-yet-completed instead.
 *
 * Takes the ALREADY-DECIDED `distributionRequired` flag (Issue #87 review,
 * forge/87-mirror follow-up, Important finding 2 — second round) rather than
 * a `server`/`projectServer` pair to re-derive it from: the caller must
 * compute this flag at the SAME moment (against the SAME locked
 * project/projectServer snapshot) it resolves `distributionRepoEntry` —
 * `PhaseLoopRunner.stateMachineLoop` used to accept only the resolved
 * repository from its caller and then re-derive "was distribution required"
 * itself via a fresh `projectServerRepo.find()` read inside the loop. A
 * `distributeCode` toggle flipped mid-run (between when the run
 * started/resumed and locked its repository, and whenever that fresh read
 * happened) made the fresh read disagree with what was actually true when
 * distribution ran — turning this check `false` (and the pushing probe/hub
 * notary permissive again) even though the locked repository had since been
 * deleted. Passing the flag itself closes that gap the same way passing the
 * resolved repository itself already did.
 *
 * Distribution-not-required callers are unaffected: `distributionRequired`
 * is `false` there, so this always returns `false` regardless of `repo`,
 * preserving the pre-existing SHA-only verification behavior for projects
 * that have never touched distribution.
 */
export function isDistributionRequiredButRepositoryUnresolved(
  distributionRequired: boolean,
  repo: unknown | null | undefined,
): boolean {
  return distributionRequired && !repo;
}

/**
 * Result of resolving the repository a resumed/continued run (follow-up,
 * resumeStateMachine, isPushCompleted) must treat as THE repository, given a
 * task's recorded `distributionRepositoryId` (Issue #87 review follow-up,
 * Important findings 2 & 3).
 *
 * `ok: false` means the task has a recorded value that no longer resolves —
 * the repository row was deleted since distribution ran. The caller MUST
 * fail closed (never fall back to `resolveExecutionRepositoryEntry`'s
 * current-config resolution) — see `resolveRecordedDistributionRepositoryEntry`'s
 * doc comment for why.
 */
export type RecordedDistributionRepositoryResolution =
  | { ok: true; entry: ProjectRepository | null }
  | { ok: false; recordedRepositoryId: number };

/**
 * Single source of truth for "which repository must this task's resumed/
 * continued execution treat as THE repository", shared by
 * `ExecuteTaskUseCase.resumeStateMachine()`, `followUp()`'s state-machine
 * continuation, and `isPushCompleted()` (Issue #87 review follow-up,
 * Important findings 2 & 3 — those three call sites used to each hand-roll
 * this same rule, and two of them had drifted to re-resolving from the
 * project/project-server's CURRENT configuration instead).
 *
 * A task's working directory holds code from whichever repository fetch
 * distribution actually pulled it from at execute()/restore() time
 * (`task.distributionRepositoryId`, migration 067) — that fact never changes
 * for the life of the task's working directory, even if an operator later
 * repoints the project server's `distributionRepositoryId` at a different
 * repository, or deletes the recorded one outright. So:
 *
 * - A non-null recorded value is authoritative and MUST be used as-is. If it
 *   no longer resolves (the repository row was deleted), this returns
 *   `{ ok: false }` and the caller must refuse to proceed with a different
 *   repository (fail closed) — falling back to the live config here is
 *   exactly the "notarize/push repository A's code against repository B"
 *   bug this column exists to prevent.
 * - A null recorded value means either the task predates this column, or its
 *   execute()/restore() run never went through distribution at all — in
 *   that case this falls back to `resolveExecutionRepositoryEntry`'s live
 *   resolution exactly as every call site did before this column existed
 *   (itself already fail-closed when distribution is currently required but
 *   unresolved, and a plain `repositories[0]` lookup otherwise).
 */
export function resolveRecordedDistributionRepositoryEntry(
  recordedRepositoryId: number | null | undefined,
  server: Pick<ServerConfig, 'type' | 'isolationIntent'> | null,
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null,
  project: Pick<ProjectDetail, 'repositories'> | null,
): RecordedDistributionRepositoryResolution {
  if (recordedRepositoryId != null) {
    const resolved = project?.repositories?.find((r) => r.id === recordedRepositoryId) ?? null;
    if (!resolved) return { ok: false, recordedRepositoryId };
    return { ok: true, entry: resolved };
  }
  return { ok: true, entry: resolveExecutionRepositoryEntry(server, projectServer, project) };
}

/**
 * Whether a run whose own `performDistribution()` call returned
 * `{ required: false }` (this run did NOT need to distribute) may clear
 * `task.distributionRepositoryId` (Issue #87 review, forge/87-mirror
 * follow-up, Important finding 3).
 *
 * `required: false` only means "this run did not distribute THIS time" — it
 * says nothing about whether a PAST run's checkout is still sitting on disk.
 * Toggling `distributeCode` off on the SAME server the task already
 * distributed onto does not erase that checkout, and the worktree
 * execute()/restore() (re)creates right after this check still comes from
 * it. Clearing the record unconditionally (the previous behavior) made every
 * downstream consumer that trusts it
 * (`resolveRecordedDistributionRepositoryEntry`) fall back to
 * `project.repositories[0]` — silently retargeting push/PR verification at a
 * DIFFERENT repository than the one actually checked out.
 *
 * The record may be cleared ONLY when this function can point to positive
 * evidence that a DIFFERENT source was established — never merely because
 * distribution happened not to run this time. The only such evidence
 * available without a schema change is `distribution_state`
 * (`IDistributionStateRepository`, already written by
 * `FetchDistributionService.distributeUnlocked()` on every successful
 * distribution, keyed by `(serverName, repositoryId)`): a row existing for
 * THIS run's resolved server and the recorded repository id is direct proof
 * that server actually received that repository's content — the record is
 * accurate for the server this run is about to (re)use, so it is kept. No
 * row existing means either the recorded distribution ran against a
 * DIFFERENT server (the task's server/project-server config changed since),
 * or no distribution state was ever recorded for this pairing — in both
 * cases the record no longer describably matches what THIS run's server
 * holds, so it is cleared rather than kept "just in case", matching this
 * task's existing "explicit id or nothing" fail-closed convention (see
 * `resolveExecutionRepositoryEntry`'s doc comment) over silently trusting a
 * value this function cannot corroborate.
 *
 * `recordedRepositoryId` null (nothing recorded yet) always returns `false`
 * — there is nothing to clear.
 */
export function shouldClearRecordedDistributionRepository(
  distributionStateRepo: IDistributionStateRepository,
  serverName: string,
  recordedRepositoryId: number | null | undefined,
): boolean {
  if (recordedRepositoryId == null) return false;
  return distributionStateRepo.find(serverName, recordedRepositoryId) == null;
}

/**
 * The subset of {@link DistributionFailureStage} values a purely local,
 * remote-free prerequisite check can produce (Issue #87 配信状態の可視化).
 * `distribute_failed`/`stale_local_branch` are deliberately excluded: both
 * are outcomes of the distribution attempt itself, never of its
 * preconditions.
 */
export type DistributionPrerequisiteStage =
  | 'service_not_wired'
  | 'no_working_dir'
  | 'no_distribution_repository'
  | 'distribution_repository_not_found'
  | 'no_token'
  | 'credential_unreadable'
  | 'identity_unresolvable';

/**
 * What a caller's credential lookup found for the distribution target
 * repository (Issue #87 配信状態の可視化). The lookup — not this module —
 * decides HOW the credential is fetched, because the two callers need
 * different fetch behavior: `performDistribution` reads the one repository
 * it is about to use and lets a decryption failure propagate exactly as
 * before, while the read-only listing bulk-loads every referenced repository
 * and reports a decryption failure as `unreadable` instead of failing the
 * whole response.
 */
export type DistributionRepositoryFields = Pick<ProjectRepository, 'url' | 'provider' | 'owner' | 'repoName'>;

export type DistributionRepositoryLookup =
  | { status: 'ok'; repo: DistributionRepositoryFields; token: string }
  /**
   * The row exists but carries no PAT. `repo` is then present and the check
   * falls through to the hub's own `gh`/`glab` CLI credential for that
   * repository's host (the second stage of the two-stage resolution in
   * `docs/ja/github-integration.md`). `repo` is absent ONLY when there is no
   * row at all to read an identity from — an id pointing at a deleted
   * repository — in which case no CLI lookup is possible either.
   */
  | { status: 'no_token'; repo?: DistributionRepositoryFields }
  | { status: 'unreadable' };

/**
 * Which credential hub代行 distribution would authenticate with (Issue #87).
 * `repository` = the `project_repositories` row's stored PAT; `cli` = the
 * hub's own `gh`/`glab` CLI token for that repository's host.
 */
export type DistributionCredentialSource = 'repository' | 'cli';

export interface CheckDistributionPrerequisitesParams {
  server: Pick<ServerConfig, 'type' | 'isolationIntent'>;
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null;
  project: Pick<ProjectDetail, 'repositories'> | null;
  workingDir: string | null;
  /** Resolves the distribution target repository's credential — called at most once, only after the target id is known. */
  lookupRepository: (repositoryId: number) => DistributionRepositoryLookup;
  /**
   * ALREADY-RESOLVED view of the hub's `gh`/`glab` credentials
   * ({@link resolveCliTokens}), consulted only when the repository itself
   * carries no PAT.
   *
   * Passed in rather than resolved here because this function is
   * synchronous and is rendered per row by GET /api/projects/:id/servers:
   * spawning `gh` from inside it would block the event loop for the CLI's
   * timeout on every poll. Callers resolve the (few, de-duplicated) hosts
   * they actually need asynchronously first, then hand the result in. Pass
   * {@link NO_CLI_TOKEN} for a caller that must not consider CLI
   * credentials at all.
   */
  cliToken: CliTokenLookup;
  fetchDistributionService: FetchDistributionService | null;
}

export type DistributionPrerequisiteResult =
  | { required: false }
  | {
      required: true;
      ok: true;
      /** The `project_repositories` id distribution would pull from. */
      repositoryId: number;
      /** Non-null by construction: a null/empty working directory fails as `no_working_dir`. */
      workingDir: string;
      /** Resolved, non-empty token for {@link repositoryId} — never surfaced outside this process. */
      token: string;
      /**
       * WHERE {@link token} came from: the repository's stored PAT
       * (`repository`) or the hub operator's `gh`/`glab` login (`cli`).
       *
       * Surfaced through the API (never the token itself) because the two
       * are not equivalent in durability: a `cli` credential is ambient
       * operator environment and vanishes on `gh auth logout` with no
       * change to any AZITO configuration.
       */
      credentialSource: DistributionCredentialSource;
      identity: CanonicalRepositoryIdentity;
      /** Non-null by construction: a null service fails as `service_not_wired`. */
      fetchDistributionService: FetchDistributionService;
    }
  | { required: true; ok: false; stage: DistributionPrerequisiteStage; message: string };

/**
 * The prerequisite half of {@link performDistribution} — every check that
 * runs BEFORE `transportFactory.getTransport(server)`, i.e. every check that
 * touches nothing but the hub's own database rows (Issue #87 配信状態の可視化).
 *
 * Extracted so the same verdict can be rendered in a list (GET
 * /api/projects/:id/servers) without executing a task first: before this
 * existed, a project server whose `distribution_repository_id` was never set
 * (e.g. the "use an existing directory" branch of the project wizard) looked
 * perfectly healthy until the first task failed on `no_distribution_repository`.
 *
 * Makes NO remote connection, spawns no process, and invokes
 * `lookupRepository` at most once. `performDistribution` calls this and nothing
 * else for its own prerequisite phase, so the two can never drift — the
 * stage values, their order, and their messages are this function's alone.
 *
 * The `message` is INTERNAL (it can embed the identity-resolution reason and
 * is written for hub logs/execution logs). API surfaces must expose `stage`
 * only and localize from that — never forward `message` to a client.
 */
export function checkDistributionPrerequisites(
  params: CheckDistributionPrerequisitesParams,
): DistributionPrerequisiteResult {
  const { server, projectServer, project, workingDir, lookupRepository, cliToken, fetchDistributionService } = params;

  if (!isDistributionRequired(server, projectServer)) {
    return { required: false };
  }

  if (!fetchDistributionService) {
    return {
      required: true,
      ok: false,
      stage: 'service_not_wired',
      message: 'Fetch distribution is required (server isolation intent or project distribute_code) but FetchDistributionService is not wired',
    };
  }

  if (!workingDir) {
    return {
      required: true,
      ok: false,
      stage: 'no_working_dir',
      message: 'Fetch distribution is required (server isolation intent or project distribute_code) but no working directory is configured for this task/server',
    };
  }

  // Issue #87 explicit-target follow-up: the target repository is resolved
  // from `projectServer.distributionRepositoryId`, never inferred from
  // `project.repositories[0]`/"exactly one repository configured" — see
  // `ProjectServer.distributionRepositoryId`'s doc comment and this
  // module's own doc comment. Required even when the project has exactly
  // one repository (deliberately not defaulted to it): an operator
  // approving distribution for a project server is approving "code from
  // THIS repository, on THIS server", and inferring a single-repository
  // project's implicit repository would let a later-added second repository
  // silently make a previously-unambiguous choice ambiguous again with no
  // signal at the project-server row itself — the explicit column is the
  // one place that choice is recorded and can be reviewed/changed
  // independently of how many repositories the project happens to have.
  const distributionRepositoryId = projectServer?.distributionRepositoryId ?? null;
  if (distributionRepositoryId === null) {
    return {
      required: true,
      ok: false,
      stage: 'no_distribution_repository',
      message: 'Fetch distribution is required but no distribution target repository is configured for this project server. Select one in Settings → Servers for this project/server pairing.',
    };
  }

  const repoEntry = project?.repositories?.find((r) => r.id === distributionRepositoryId);
  if (!repoEntry) {
    return {
      required: true,
      ok: false,
      stage: 'distribution_repository_not_found',
      message: 'Fetch distribution is required but the configured distribution target repository no longer exists on this project',
    };
  }

  const lookup = lookupRepository(repoEntry.id);
  if (lookup.status === 'unreadable') {
    return {
      required: true,
      ok: false,
      stage: 'credential_unreadable',
      message: 'Fetch distribution is required but the repository\'s stored credential could not be decrypted (master key mismatch or corrupted ciphertext)',
    };
  }
  const noToken = { required: true, ok: false, stage: 'no_token', message: 'Fetch distribution is required but the repository has no token configured' } as const;
  // No row at all (the id names a deleted repository): no identity to
  // resolve, so the CLI fallback has no host to ask about either.
  if (!lookup.repo) return noToken;

  // Resolved BEFORE the token decision, not after: the CLI fallback is
  // per-host, so the canonical host must be known before it can be
  // consulted. A repository whose URL does not normalize therefore reports
  // `identity_unresolvable` (the reason it is undistributable) even when it
  // also has no PAT.
  const identity = resolveCanonicalRepositoryIdentity(lookup.repo);
  if (!identity.ok) {
    return {
      required: true,
      ok: false,
      stage: 'identity_unresolvable',
      message: `Fetch distribution is required but the repository URL could not be normalized to a canonical identity: ${identity.reason}`,
    };
  }

  // Stage 1: the repository's own PAT. Stage 2: the hub's `gh`/`glab`
  // credential for this host — `docs/ja/github-integration.md`'s documented
  // two-stage resolution, which the provider API clients have always applied
  // and distribution now applies too. `no_token` means BOTH are absent; the
  // failure is never hidden behind a silent no-op.
  let token: string;
  let credentialSource: DistributionCredentialSource;
  if (lookup.status === 'ok') {
    token = lookup.token;
    credentialSource = 'repository';
  } else {
    const cli = cliToken({ provider: identity.identity.provider, host: identity.identity.host });
    if (!cli) return noToken;
    token = cli;
    credentialSource = 'cli';
  }

  return {
    required: true,
    ok: true,
    repositoryId: repoEntry.id,
    workingDir,
    token,
    credentialSource,
    identity: identity.identity,
    fetchDistributionService,
  };
}

export interface PerformDistributionParams {
  server: ServerConfig;
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null;
  project: Pick<ProjectDetail, 'repositories'> | null;
  workingDir: string | null;
  baseBranch: string;
  taskBranch: string | null;
  transportFactory: TransportFactory;
  projectRepo: IProjectRepository;
  fetchDistributionService: FetchDistributionService | null;
  /**
   * Called exactly once per `performDistribution()` call that reaches it,
   * synchronously, immediately before the point INSIDE
   * `fetchDistributionService.distribute()` where the LOCAL working
   * directory is actually about to change (`ensureWorkingDir()` — see
   * `FetchDistributionParams.onBeforeWorkingDirChange`'s doc comment in
   * `hub-transfer/types.ts`), not merely before `distribute()` is called at
   * all (Issue #87 review, forge/87-mirror follow-up, Important finding 2,
   * third round).
   *
   * Every prerequisite check in THIS function
   * (`service_not_wired`/`no_working_dir`/`no_distribution_repository`/
   * `distribution_repository_not_found`/`no_token`/`identity_unresolvable`)
   * has already passed by the time `distribute()` is even called — but
   * `distribute()` itself can still fail before touching `workingDir`:
   * resolving `sshHost` to a home directory, preparing the hub's own repo
   * cache, and transferring the bundle onto the remote mirror all run BEFORE
   * `ensureWorkingDir()` and can all fail on their own (see
   * `FetchDistributionService.distribute()`/`distributeUnlocked()`). Firing
   * this callback right after `performDistribution()`'s own checks (the
   * previous fix, Issue #87 review follow-up second round) but before
   * calling `distribute()` fired it too early for those failures too — the
   * record would already claim this run's target repository even though the
   * working directory was never touched, exactly the bug the previous round
   * meant to close. Threading the callback one layer deeper, to fire from
   * inside `distributeUnlocked()` itself, closes that remaining gap: a
   * record write happens if and only if this run is actually about to
   * change what's on `workingDir`'s disk. Callers use this to persist
   * `task.distributionRepositoryId` with `repositoryId`; never invoked at
   * all when `performDistribution`/`distribute()` returns before reaching
   * that point (distribution not required, any of this function's own
   * prerequisite checks failed, or `distribute()` itself fails before
   * `ensureWorkingDir()`).
   */
  onBeforeDistribute?: (repositoryId: number) => void;
}

/**
 * The async half of `performDistribution`'s prerequisite phase: resolves the
 * hub's `gh`/`glab` credential for the ONE repository this run would
 * distribute, so the synchronous `checkDistributionPrerequisites` can consult
 * it without spawning anything.
 *
 * Deliberately silent about every reason it might not find a target — it
 * never reports a failure of its own. `checkDistributionPrerequisites` runs
 * the same resolution immediately afterwards and owns every stage value and
 * message; duplicating the diagnosis here would be the one way the two could
 * drift apart.
 *
 * The CLI is asked ONLY when the repository has no PAT of its own, so a
 * PAT-configured project never spawns a process here.
 */
async function resolveCliTokenForTarget(params: {
  server: Pick<ServerConfig, 'type' | 'isolationIntent'>;
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null;
  project: Pick<ProjectDetail, 'repositories'> | null;
  findRepo: (repositoryId: number) => ProjectRepositoryWithToken | null;
}): Promise<CliTokenLookup> {
  const { server, projectServer, project, findRepo } = params;
  if (!isDistributionRequired(server, projectServer)) return NO_CLI_TOKEN;

  const repositoryId = projectServer?.distributionRepositoryId ?? null;
  if (repositoryId === null) return NO_CLI_TOKEN;
  if (!project?.repositories?.some((r) => r.id === repositoryId)) return NO_CLI_TOKEN;

  const repo = findRepo(repositoryId);
  if (!repo || repo.token) return NO_CLI_TOKEN;

  const identity = resolveCanonicalRepositoryIdentity(repo);
  if (!identity.ok) return NO_CLI_TOKEN;

  const target = { provider: identity.identity.provider, host: identity.identity.host };
  const token = await getCliToken(target);
  return (asked) => (asked.provider === target.provider && asked.host === target.host ? token : null);
}

/**
 * Runs the full prerequisite validation (repository configured, exactly one
 * repository, token present, URL resolves to a canonical identity) and, if
 * all pass, the distribution itself — the same sequence
 * ExecuteTaskUseCase.execute() ran inline before this extraction. Returns a
 * discriminated result instead of throwing so each caller can apply its own
 * logging/rollback/task-status convention around a failure.
 */
export async function performDistribution(params: PerformDistributionParams): Promise<DistributionOutcome> {
  const { server, projectServer, project, workingDir, baseBranch, taskBranch, transportFactory, projectRepo, fetchDistributionService, onBeforeDistribute } = params;

  // Read (and decrypted) at most once even though both the CLI-token
  // pre-pass below and `checkDistributionPrerequisites` itself need it.
  let cachedRepo: ProjectRepositoryWithToken | null | undefined;
  const findRepo = (repositoryId: number): ProjectRepositoryWithToken | null => {
    if (cachedRepo === undefined) cachedRepo = projectRepo.findRepositoryById(repositoryId);
    return cachedRepo;
  };

  // `checkDistributionPrerequisites` is synchronous by contract, so the
  // hub's own `gh`/`glab` credential — needed only when the repository has
  // no PAT of its own — is resolved here, asynchronously, before the check
  // runs. Best effort by design: when this cannot even identify a target
  // (distribution not required, no/unknown target repository, unnormalizable
  // URL) it resolves nothing and the check below reports the real reason.
  const cliToken = await resolveCliTokenForTarget({ server, projectServer, project, findRepo });

  // Every check that runs before the transport is obtained lives in
  // `checkDistributionPrerequisites` — the SAME function GET
  // /api/projects/:id/servers renders, so the list view and an actual run can
  // never disagree about why a project server is not distributable.
  const prerequisites = checkDistributionPrerequisites({
    server,
    projectServer,
    project,
    workingDir,
    // Unchanged execution-path behavior: `findRepositoryById` decrypts
    // eagerly and a `SecretBox.open()` failure propagates out of
    // `performDistribution` exactly as it did before this extraction — a run
    // that cannot read its own credential must not proceed. `unreadable` is
    // therefore never produced here; it exists for the read-only listing
    // path, which must degrade one row instead of the whole response.
    lookupRepository: (repositoryId) => {
      const repo = findRepo(repositoryId);
      if (!repo) return { status: 'no_token' };
      return repo.token ? { status: 'ok', repo, token: repo.token } : { status: 'no_token', repo };
    },
    cliToken,
    fetchDistributionService,
  });
  if (!prerequisites.required) return { required: false };
  if (!prerequisites.ok) {
    return { required: true, ok: false, stage: prerequisites.stage, message: prerequisites.message };
  }
  const transport = transportFactory.getTransport(server);

  // Every prerequisite check THIS function runs has now passed — but
  // `distribute()` below can still fail before ever touching `workingDir`
  // (resolving `sshHost`'s home directory, preparing the hub's own repo
  // cache, transferring the bundle onto the remote mirror). So the callback
  // is NOT fired here; it is threaded through as
  // `onBeforeWorkingDirChange` and fired by `distribute()` itself, exactly
  // once, immediately before the one step INSIDE it that actually mutates
  // `workingDir` (`ensureWorkingDir()`). See `onBeforeDistribute`'s doc
  // comment on `PerformDistributionParams` above for the full rationale.
  const distResult = await prerequisites.fetchDistributionService.distribute({
    server,
    transport,
    repoIdentity: prerequisites.identity,
    token: prerequisites.token,
    branch: baseBranch,
    workingDir: prerequisites.workingDir,
    repositoryId: prerequisites.repositoryId,
    onBeforeWorkingDirChange: onBeforeDistribute ? () => onBeforeDistribute(prerequisites.repositoryId) : undefined,
  });

  if (distResult.status === 'failed') {
    // Prefixed (unlike every other failure `message` in this function,
    // which is already a complete sentence) to match ExecuteTaskUseCase's
    // pre-extraction wording exactly — this is the one message vitest's
    // existing test suite asserts on verbatim.
    return { required: true, ok: false, stage: 'distribute_failed', message: `Fetch distribution failed: ${distResult.error ?? 'unknown error'}` };
  }

  // See ExecuteTaskUseCase's original comment on this guard for the full
  // TOCTOU rationale: only matters when `taskBranch` names the SAME branch
  // fetch distribution just (tried to) advance — any other branch/no branch
  // resolves `origin/<baseBranch>` at worktree-creation time and never
  // touches this possibly-stale local ref.
  if (
    distResult.localBranchSynced === false &&
    taskBranch &&
    normalizeBranchRef(taskBranch) === normalizeBranchRef(baseBranch)
  ) {
    return {
      required: true,
      ok: false,
      stage: 'stale_local_branch',
      message: `Fetch distribution succeeded but the local branch "${taskBranch}" in ${prerequisites.workingDir} could not be updated to the distributed content — it is likely checked out in another worktree on the server. Remove or update that worktree, or specify a different branch name for this task, and retry.`,
    };
  }

  return {
    required: true,
    ok: true,
    distStatus: distResult.status,
    sha: distResult.sha,
    bundleType: distResult.bundleType,
    localBranchSynced: distResult.localBranchSynced,
    repositoryId: prerequisites.repositoryId,
  };
}
