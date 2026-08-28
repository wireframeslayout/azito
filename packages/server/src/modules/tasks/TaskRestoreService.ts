import type { ITaskRepository, Task } from './Task';
import type { TaskStatus } from './TaskStatus';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import { resolveEffectiveInputPolicy } from '../projects/ProjectServer';
import type { IUnitRepository } from '../units/Unit';
import type { IWindowRepository } from '../windows/Window';
import type { SqliteProjectSecretRepository } from '../projects/SqliteProjectSecretRepository';
import type { TmuxClient } from '../tmux/TmuxClient';
import { createRotatedWindow, ensureSessionWithLock, rollbackWindowReference, runExclusiveForTask, ServerSnapshotMismatchError, type ServerIsolationLock } from './execution/WindowRotation';
import type { KeyedMutex } from '../../shared/keyedMutex';
import type { WorktreeServiceFactory } from '../git/WorktreeServiceFactory';
import { PathResolverFactory, assertDirectoryContained } from '../git/PathContainment';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IContentExtractor } from '../llm/ContentExtractor';
import type { IExecutionLogRepository } from './ExecutionLog';
import { resolveTaskServerName, resolveTmuxSession, resolveBaseBranch, canonicalizeBaseBranch, resolveWorktreeCreateBaseBranch } from './execution/TaskExecutionEnv';
import { performDistribution, type DistributionOutcome } from './execution/DistributionHelper';
import { normalizeBranchRef } from '../git/assertSafeGitArgs';
import { buildWorkerLaunchCommand } from '../agents/LaunchCommand';
import { shellQuote } from '../../shared/shellQuote';
import { checkExecutionGate, ExecutionGateDeniedError, ExecutionGatePendingApprovalError, reverifyExecutionGateInLock } from './execution/ExecutionGate';
import { resolveExecutionManifest, hashExecutionManifest } from './execution/ExecutionManifest';
import { appendLogAndEmit } from './execution/AppendLog';
import type { TaskPaneEnvironmentService } from './execution/TaskPaneEnvironmentService';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { EventEmitter } from 'events';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TaskRestoreDeps {
  taskRepo: ITaskRepository;
  serverRepo: IServerRepository;
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  unitRepo: IUnitRepository;
  windowRepo: IWindowRepository;
  // Needed by resolveExecutionManifest() to resolve `secrets.namesDigest`
  // (Issue #328 tenth-round review) the same way every other execution
  // entry point does.
  projectSecretRepo: SqliteProjectSecretRepository;
  tmux: TmuxClient;
  worktreeServiceFactory: WorktreeServiceFactory;
  transportFactory: TransportFactory;
  contentExtractor: IContentExtractor;
  logRepo: IExecutionLogRepository;
  // Needed by resolveExecutionManifest() to resolve the `sidekick` manifest
  // field the same way PhaseLoopRunner resolves it for an actual run (Issue
  // #328 sixth-round review) — same singletons ExecuteTaskUseCase is wired
  // with (see app/wiring.ts).
  unitTypeLoader: UnitTypeLoader;
  sidekickLoader: SidekickPackageLoader;
  // Shared task-events EventEmitter (Issue #328 fifteenth-round review) —
  // the SAME instance ExecuteTaskUseCase is constructed with, so
  // appendLogAndEmit() calls here reach buildServer.ts's NotificationBus/
  // push bridges exactly like ExecuteTaskUseCase's own do. See
  // AppendLog.ts's doc comment for why a second, unwired notification path
  // is exactly how the bug this fixes happened.
  events: EventEmitter;
  /** Issue #28 Phase A後半: the sole task-pane env builder — this is the "TaskRestoreService" entry point design v3 §6 lists explicitly. */
  paneEnvService: TaskPaneEnvironmentService;
  // Issue #29 review (7th pass), Important finding 1: the SAME
  // per-server-name mutex `modules/servers/routes.ts`'s PUT handler and
  // `modules/tmux/routes/sessions.ts`'s manual window/pane routes already
  // serialize the isolation false->true transition against (see that
  // mutex's own doc comment) — required here too, so a task restore can
  // never build env from a `server` object a concurrent transition has
  // already superseded. See ServerIsolationLock's doc comment in
  // WindowRotation.ts.
  serverIsolationMutex: KeyedMutex;
  // Issue #29 Step 3a: same flag ExecuteTaskUseCase/PhaseLoopRunner are
  // constructed with — restore()'s own execution-gate re-check below needs
  // it for resolveEffectiveInputPolicy(), the same as every other entry
  // point.
  scopedAuthEnabled: boolean;
  // Issue #87 13th-round review, Important finding 1: the SAME instance
  // ExecuteTaskUseCase is constructed with (see wiring.ts's
  // buildFetchDistributionService doc comment for why it must be shared, not
  // a second instance) — restore() runs the same performDistribution() check
  // execute() does, so an archived task restored onto an isolated or
  // distribute_code server gets its worktree recreated from freshly
  // distributed content instead of whatever stale local state happens to
  // already be at workingDir. Nullable only because some test fixtures don't
  // wire it; a restore that actually needs distribution and finds this null
  // fails via performDistribution's own 'service_not_wired' outcome.
  fetchDistributionService: import('../git/hub-transfer/FetchDistributionService').FetchDistributionService | null;
}

export class TaskRestoreService {
  private readonly pathResolverFactory = new PathResolverFactory();

  constructor(private deps: TaskRestoreDeps) {}

  private get serverIsolationLock(): ServerIsolationLock {
    return { serverIsolationMutex: this.deps.serverIsolationMutex, serverRepo: this.deps.serverRepo };
  }

  async restore(task: Task, log: { warn: (msg: string) => void }): Promise<{ tmuxTarget: string; worktreePath: string | null }> {
    const { taskRepo, serverRepo, projectRepo, projectServerRepo, unitRepo, windowRepo, tmux, worktreeServiceFactory, transportFactory, contentExtractor, logRepo, unitTypeLoader, sidekickLoader, projectSecretRepo, events, paneEnvService, scopedAuthEnabled, fetchDistributionService } = this.deps;

    const serverName = resolveTaskServerName(task, projectServerRepo);
    if (!serverName) {
      throw new Error('Cannot resolve server: task has no serverName and its project does not have exactly one project_servers entry');
    }

    const serverAtStart = serverRepo.findByName(serverName);
    if (!serverAtStart) {
      throw new Error(`Server '${serverName}' not found`);
    }
    // `let`, not `const`: reassigned below (ensureSessionWithLock,
    // createRotatedWindow) to whatever fresher row the isolation lock
    // re-read — explicitly typed `ServerConfig` (not inferred from
    // `findByName`'s nullable return) so TS control-flow narrowing isn't
    // lost the moment this variable is captured by a nested closure below.
    let server: ServerConfig = serverAtStart;

    const tmuxSession = resolveTmuxSession(task.projectId, serverName, projectServerRepo);

    // Untrusted-input execution gate (Issue #328), same
    // resolveExecutionManifest()+checkExecutionGate() pairing as
    // ExecuteTaskUseCase's entry points — restoring an archived task
    // recreates its tmux window and worktree from scratch, so it needs the
    // identical pre-launch check, run before any of that happens.
    // project/unit/projectServer are resolved here and reused below
    // (unit may be null: restore() has always tolerated a task whose Unit
    // was deleted or was never set on either the task or its project).
    const { manifest, project, unit, projectServer } = resolveExecutionManifest(task, { unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader });
    const unitId = unit?.id ?? null;
    const manifestHash = hashExecutionManifest(manifest);
    // Issue #29 Step 3a: `server` here is the already-resolved ServerConfig
    // (serverAtStart, re-read fresh under the isolation lock further down) —
    // same re-check every other entry point runs, see
    // resolveEffectiveInputPolicy's doc comment.
    const effective = resolveEffectiveInputPolicy(projectServer, server, scopedAuthEnabled);
    if (unitId !== null && effective.allowDegradedReason) {
      appendLogAndEmit(logRepo, events, task.id, unitId, 'command', {
        type: 'execution_policy_degraded',
        requestedPolicy: effective.requestedPolicy,
        effectivePolicy: effective.effectivePolicy,
        allowDegradedReason: effective.allowDegradedReason,
      });
    }
    const gate = checkExecutionGate(task, effective.effectivePolicy, manifestHash);
    if (!gate.allowed) {
      if (unitId !== null) {
        appendLogAndEmit(logRepo, events, task.id, unitId, 'command', { type: 'execution_gate_blocked', reason: gate.reason });
      }
      if (gate.reason === 'pending_approval') {
        // pendingOperation records that the blocked operation was a restore
        // (not a fresh execute()), so the approval handler
        // (modules/units/routes.ts) resumes it by calling restore() again
        // instead of guessing from task.tmuxWindow — an archived task never
        // has a tmuxWindow either, so that heuristic couldn't tell "was being
        // restored" apart from "never started" (Issue #328 third-round
        // review finding 1). The task's prior 'archived' status is not lost
        // by moving to 'pending_approval' here: restore() sets status to
        // 'open' on success (see below) — the same transition a normal,
        // ungated restore() always makes — so once approval re-invokes this
        // method, the end state matches what restoring would have done in
        // the first place.
        //
        // Atomic compare-and-swap (Issue #328 review round fix 1): this used
        // to call the generic read-then-write `taskRepo.update(...)`
        // unconditionally, which — exactly like ExecuteTaskUseCase's own gate
        // before its fix — could overwrite an already-recorded block from a
        // concurrently-blocked entry point (e.g. a respawn racing this
        // restore for the same untrusted task) and corrupt
        // pendingOperationPriorStatus with 'pending_approval' itself. See
        // recordExecutionGateBlock's doc comment on ITaskRepository.
        const recorded = taskRepo.recordExecutionGateBlock(task.id, {
          pendingOperation: 'restore',
          priorStatus: task.status,
          manifestHash,
        });
        // A 'status_change' entry, not just the 'command' entry above, is
        // what the NotificationBus/push bridges (buildServer.ts) turn into a
        // live browser notification — but ONLY when it's emitted on the
        // shared events EventEmitter they subscribe to, not merely persisted
        // via logRepo.append(). Before Issue #328 fifteenth-round review,
        // this called logRepo.append() directly (this comment used to claim
        // that alone was sufficient, mirroring
        // ExecuteTaskUseCase.enforceExecutionGate's real behavior — it
        // wasn't: TaskRestoreService had no way to reach that class's private
        // EventEmitter). See AppendLog.ts's appendLogAndEmit() doc comment.
        // Guarded on unitId !== null the same as the 'command' log above it
        // (an archived task can have no resolvable Unit). Only emitted when
        // `recorded` is true — a no-op (already-blocked) attempt must not
        // re-notify a client that already saw the first block's own
        // 'status_change' (same reasoning as
        // ExecuteTaskUseCase.enforceExecutionGate's own pending_approval
        // branch).
        if (recorded) {
          if (unitId !== null) {
            appendLogAndEmit(logRepo, events, task.id, unitId, 'status_change', { status: 'pending_approval', operation: 'restore' });
          }
        } else if (unitId !== null) {
          appendLogAndEmit(logRepo, events, task.id, unitId, 'command', { type: 'execution_gate_already_pending', operation: 'restore' });
        }
        throw new ExecutionGatePendingApprovalError(task.id);
      }
      // 'denied': leave status untouched (still 'archived') — see the matching
      // comment in ExecuteTaskUseCase.enforceExecutionGate for the rationale.
      throw new ExecutionGateDeniedError(task.id);
    }

    // Throwaway bootstrap window — the real task window is created just
    // below via createWindow, which is what actually gets AZITO_TASK_TOKEN
    // (see the comment there and TaskPaneEnvironmentService's own doc
    // comment). Routed through `ensureSessionWithLock`, which masks (not
    // injects) via `isolationMaskForServer` (Issue #29 review, 11th pass,
    // Critical finding 1 — this is a TASK session, so it must never inject
    // the operator UI token the way `uiTokenEnvForServer` does for a
    // non-isolated server): an isolated server's tmux SESSION-level env can
    // already carry a leftover AZITO_UI_TOKEN/AZITO_AGENT_TOKEN from a
    // prior non-isolated life, and this window's own pane always inherits
    // whatever process env the tmux SERVER itself runs under (the remote
    // agent process's env, for an `agent`-type server) regardless of what
    // `extraEnv` this call passes — an empty object masks nothing.
    //
    // Routed through ensureSessionWithLock (Issue #29 review, 10th pass,
    // Critical finding 1): the existence check AND the createSession call
    // both now run inside the isolation lock against a `server` row re-read
    // only once the lock is held — never against the `server` resolved at
    // the top of restore(), which a concurrent isolation PUT may have
    // already superseded. `server` is reassigned to the fresh row so
    // everything this function does afterwards (resolvePaneId, the
    // transport used for containment checks, worktree creation, sendKeys,
    // the rollback's killWindow, ...) sees it too.
    let sessionResult: { created: boolean; server: ServerConfig };
    try {
      sessionResult = await ensureSessionWithLock(tmux, this.serverIsolationLock, server, tmuxSession);
    } catch (err) {
      // Issue #29 review, 12th pass, Critical finding 1: the server row
      // ensureSessionWithLock re-read once the isolation lock was actually
      // held disagreed with the one this run's execution gate check (above)
      // ran against — mark the task failed (not left at 'archived', which
      // reads as "never attempted") instead of letting the generic 500
      // handler in routes.ts leave status untouched.
      if (err instanceof ServerSnapshotMismatchError) {
        if (unitId !== null) appendLogAndEmit(logRepo, events, task.id, unitId, 'command', { type: 'server_snapshot_mismatch', message: err.message });
        taskRepo.update(task.id, { status: 'failed' as TaskStatus } as Partial<Task>);
      }
      throw err;
    }
    server = sessionResult.server;
    if (sessionResult.created) {
      await sleep(500);
    }

    let windowName: string | null = null;
    let worktreePath: string | null = null;
    let windowRowId: number | null = null;
    let repoDir: string | null = null;
    // Set once createRotatedWindow issues a generation below — the specific
    // row the catch block's rollbackWindowReference call revokes (Issue #28
    // third-party review, WindowRotation.ts finding: never a blanket
    // revoke-all, which could clobber a newer generation a concurrent
    // rotation for this task already persisted).
    let tokenId: number | null = null;

    // The whole issue->create->persist span this function performs (plus its
    // own rollback below) runs under a per-task lock (design v3 §2 — see
    // runExclusiveForTask's doc comment in WindowRotation.ts): without it, a
    // concurrent execute()/respawn() for the same task could revoke this
    // generation before restore() finishes persisting it.
    return await runExclusiveForTask(task.id, async () => {
    try {
      // Window generation point — rotates the task token (design v3 §2/§6:
      // restore() always (re)creates the task's window from scratch, so it
      // always rotates, same as execute()). Routed through
      // createRotatedWindow() (Issue #28 Phase A last-round fix) instead of
      // calling paneEnvService.buildEnvForNewWindow() + tmux.createWindow()
      // directly: the direct-call form only assigned `windowName` AFTER
      // creation resolved, so a thrown creation failure skipped this
      // function's own `if (windowName)` rollback below and left the
      // freshly-issued generation valid with no window backing it; it also
      // never checked a non-zero exit code on an agent-transport creation.
      // createRotatedWindow revokes the just-issued generation itself before
      // rethrowing/throwing in both cases, so `windowName` staying null here
      // on failure is correct — there is nothing left for the outer catch to
      // roll back.
      const created = await createRotatedWindow(paneEnvService, this.serverIsolationLock, server, task, 'restore_create_failed', (freshServer, env) =>
        tmux.createWindow(freshServer, tmuxSession, `task-${task.id}`, { extraEnv: env }),
        true,
        // Issue #29 Step 3a review, Important finding 2: re-verify the
        // untrusted-execution gate against `freshServer` — the row the lock
        // above already re-read — immediately before this window's env/task
        // token is built. See ExecutionGate.reverifyExecutionGateInLock's
        // doc comment for the TOCTOU this closes.
        (freshServer) => {
          const { manifest, projectServer: freshProjectServer } = resolveExecutionManifest(task, {
            unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader,
          });
          reverifyExecutionGateInLock(
            { taskRepo, logRepo, events },
            task,
            unitId,
            'restore',
            freshProjectServer,
            freshServer,
            scopedAuthEnabled,
            hashExecutionManifest(manifest),
          );
        },
      );
      windowName = created.windowName;
      tokenId = created.tokenId;
      // Issue #29 review (10th pass), Important finding 3: use the fresh
      // `server` row createRotatedWindow re-read and actually created the
      // window with — not the (possibly now-stale) argument passed into it
      // — for every subsequent tmux/transport call this function makes
      // (resolvePaneId, the containment-check transport, the worktree
      // transport, sendKeys, and the rollback's killWindow below).
      server = created.server;

      const windowTarget = `${tmuxSession}:${windowName}`;
      const paneId = await tmux.resolvePaneId(server, windowTarget);
      const dbTarget = `${windowTarget}.1`;
      // projectServer was already resolved above (by resolveExecutionManifest,
      // for the gate check) — reused here rather than re-querying.
      // allowedRoot mirrors ExecuteTaskUseCase.execute()'s containment boundary
      // (Issue #27): this restore path also launches a worker into
      // task.workingDirectory, which is settable via PUT /api/tasks/:id, so
      // it needs the same verification a fresh execute() would apply — without
      // it, startup task recovery was a way to bypass the boundary entirely
      // (Issue #27 review finding 1). No configured working directory means
      // no boundary to enforce, so containment is skipped (legacy behavior).
      const allowedRoot = projectServer?.workingDirectory || null;
      let workingDir = task.workingDirectory || allowedRoot;
      let effectiveDir = workingDir;

      let worktreeBranch: string | null = null;
      let baseBranch: string | null = null;

      if (workingDir) {
        if (task.workingDirectory && allowedRoot) {
          const transportForCheck = transportFactory.getTransport(server);
          // Resolved (symlink-free) path is what gets used below, not the
          // original task.workingDirectory — closes the same TOCTOU window
          // ExecuteTaskUseCase closes (Issue #27 review finding 2).
          workingDir = await assertDirectoryContained(
            this.pathResolverFactory, server.type, transportForCheck, { target: task.workingDirectory, allowedRoot }, 'task working directory',
          );
        }

        repoDir = workingDir;
        // Canonicalized the same way ExecuteTaskUseCase.execute() and
        // resolveExecutionManifest() both do (see `canonicalizeBaseBranch`'s
        // doc comment in TaskExecutionEnv.ts) — restore resolves
        // `baseBranch` independently of the manifest it builds above (for
        // the actual worktree creation call below, not for hashing), so
        // without this it could still create the worktree from an
        // `origin/`- or `refs/heads/`-qualified value even though the
        // approved manifest's `branches.base` (ExecutionManifest.ts) records
        // the canonicalized one (Issue #87 third-party review, 12th round,
        // Important finding 3).
        baseBranch = canonicalizeBaseBranch(resolveBaseBranch(task, projectServer, project));
        // task.branch first (Issue #328 review round, fix 1): the approval
        // manifest's `branches.work` field (ExecutionManifest.ts) hashes
        // `task.branch` — the client-specified value — not `worktreeBranch`.
        // Preferring worktreeBranch here (as an earlier round of this fix
        // did) meant an edit to an archived task's branch, followed by
        // approval of a manifest that displays and fingerprints the NEW
        // task.branch, would still restore into the OLD worktreeBranch a
        // prior run had created: the branch a human approved and the branch
        // actually used would diverge. task.branch is preferred, with
        // worktreeBranch only as a fallback for a task that has never had a
        // client-specified branch (e.g. an auto-generated one from a prior
        // run) — matching ExecuteTaskUseCase.execute's own worktree-creation
        // call, which uses `task.branch || undefined` with no worktreeBranch
        // fallback at all. The resolved result is still written ONLY to
        // `worktreeBranch` below (never back to `task.branch`), so this
        // change does not reintroduce the fingerprint self-invalidation bug
        // the removed comment described.
        // Normalized the same way ExecuteTaskUseCase.execute() normalizes
        // `task.branch` before this same worktree-creation call (Issue #87
        // third-party review, 12th round, Important finding 2) — a
        // persisted `task.branch`/`task.worktreeBranch` can still be a
        // fully-qualified ref from before the API boundary rejected new
        // ones.
        const rawBranch = task.branch || task.worktreeBranch || undefined;
        const branch = rawBranch ? normalizeBranchRef(rawBranch) : undefined;
        const slug = branch ? `task-${task.id}` : await contentExtractor.generateSlug(task.title);

        // Fetch distribution (Issue #87 13th-round review, Important finding
        // 1): restoring an archived task recreates its worktree from
        // `workingDir` exactly like execute() does, so it needs the SAME
        // pre-worktree-creation distribution check — without this, an
        // isolated server or a distribute_code project server restored a
        // task's worktree from whatever local content already happened to be
        // at `workingDir`, which could be old/stale code (or none at all).
        // Shared prerequisite-check-and-distribute logic lives in
        // performDistribution() (DistributionHelper.ts); rollback here
        // follows this function's own existing convention (the outer
        // try/catch below already rolls back the tmux window/token and, once
        // `worktreePath`+`repoDir` are set, the worktree itself — neither is
        // set yet at this point, so throwing is sufficient).
        const distOutcome: DistributionOutcome = await performDistribution({
          server,
          projectServer,
          project,
          workingDir,
          baseBranch,
          taskBranch: task.branch,
          transportFactory,
          projectRepo,
          fetchDistributionService,
        });
        if (distOutcome.required && !distOutcome.ok) {
          if (unitId !== null) {
            appendLogAndEmit(logRepo, events, task.id, unitId, 'command', { type: 'fetch_distribution_failed', error: distOutcome.message });
          }
          throw new Error(`Fetch distribution failed: ${distOutcome.message}`);
        }
        if (distOutcome.required) {
          if (unitId !== null) {
            appendLogAndEmit(logRepo, events, task.id, unitId, 'command', { type: 'fetch_distributed', sha: distOutcome.sha, bundleType: distOutcome.bundleType });
          }
        }
        const distStatus: 'distributed' | 'already_current' | null = distOutcome.required ? distOutcome.distStatus : null;
        const worktreeCreateBaseBranch = resolveWorktreeCreateBaseBranch(baseBranch, distStatus);

        const transport = transportFactory.getTransport(server);
        const worktreeService = worktreeServiceFactory.create(server.type, transport);
        const wt = await worktreeService.create(workingDir, task.id, slug, worktreeCreateBaseBranch, branch);
        worktreePath = wt.path;
        worktreeBranch = wt.branch;
        effectiveDir = wt.path;

        if (allowedRoot) {
          // Same containment check ExecuteTaskUseCase applies to a freshly
          // created worktree path; the outer try/catch below already rolls
          // back the worktree (worktreePath + repoDir are set) and tmux
          // window on any throw, so rejection here needs no separate cleanup.
          const resolvedWtPath = await assertDirectoryContained(
            this.pathResolverFactory, server.type, transport, { target: worktreePath, allowedRoot }, 'worktree path',
          );
          worktreePath = resolvedWtPath;
          effectiveDir = resolvedWtPath;
        }

        try {
          // effectiveDir is a resolved (symlink-free) real path — must be
          // shell-quoted before being typed into the pane; see the matching
          // fix/comment in ExecuteTaskUseCase (Issue #27 cd injection).
          await tmux.sendKeys(server, paneId, [`cd -- ${shellQuote(effectiveDir)}`, 'Enter']);
          await sleep(500);
        } catch (e) {
          log.warn(`[task-restore] Failed to cd into ${effectiveDir}: ${(e as Error).message}`);
        }
      }

      for (const w of windowRepo.findByTask(task.id)) {
        if (w.ownerType === 'task' && w.isPrimary) {
          windowRepo.remove(w.id);
        }
      }

      windowRowId = windowRepo.add({
        ownerType: 'task',
        projectId: null,
        taskId: task.id,
        serverName,
        tmuxTarget: dbTarget,
        label: windowName,
        isPrimary: true,
        windowType: unit?.workerType ? 'agent' : 'terminal',
        workerType: unit?.workerType ?? null,
        workerModel: unit?.workerModel ?? null,
        agentSessionId: null,
        launchCommand: unit ? buildWorkerLaunchCommand(unit.workerType, unit.workerModel, unit.workerExtraArgs) : null,
        workingDirectory: effectiveDir || null,
        paneLayout: null,
        sleeping: false,
      });

      // task.branch is deliberately NOT written here (Issue #328 review,
      // fourth recurrence of this exact self-invalidation bug — see
      // ExecuteTaskUseCase.execute's worktree-creation write and
      // PhaseLoopRunner's end-of-run git-info write for the same reasoning
      // applied at their own call sites): `branch` is the value the
      // execution-gate fingerprint hashes as `branches.work`
      // (ExecutionManifest.ts). Writing the freshly resolved worktree
      // branch back into it here made restoring a branch-unspecified,
      // already-approved task change the very fingerprint its approval was
      // granted under, so the very next gate reverification saw a mismatch
      // and threw the task back to `pending_approval`. `worktreeBranch` is
      // the correct field for "the branch the system actually
      // resolved/created" — it's in the execution-gate fingerprint's
      // deliberately-excluded list for exactly this reason.
      taskRepo.update(task.id, {
        status: 'open' as TaskStatus,
        tmuxWindow: windowName,
        worktreePath,
        worktreeBranch,
        baseBranch,
        pendingOperation: null,
      } as Partial<Task>);

      return { tmuxTarget: dbTarget, worktreePath };
    } catch (err) {
      if (windowName) {
        try {
          // The createWindow() above (line ~177) already rotated the task
          // token for THIS window generation via buildEnvForNewWindow. The
          // task's status stays 'archived' throughout this rollback (no
          // taskRepo.update touches status here) — 'archived' IS in
          // TOKEN_REVOKING_STATUSES, but that revocation already fired back
          // when the task was originally archived, before this restore
          // attempt; no status WRITE happens on this failure path to trigger
          // it again for the freshly-issued generation. Revoke it directly,
          // same fix as ExecuteTaskUseCase's rollback branches (Issue #28
          // third-party review finding) — only once rollbackWindowReference
          // confirms the kill actually worked.
          //
          // The Window row (windowRowId, added at line ~283) is removed
          // inside the SAME success branch (Issue #28 third-party review,
          // second round): removing it unconditionally — as a separate step
          // below, regardless of whether the kill above actually succeeded —
          // used to delete the only DB reference to a window that was still
          // alive and still holding a valid token whenever the kill failed.
          // Scoped to `tokenId!` (non-null here — set right after
          // createRotatedWindow, same branch condition as `windowName`
          // being set), not `task.id` — a blanket revoke could otherwise
          // clobber a newer generation a concurrent rotation for this task
          // already persisted (Issue #28 third-party review, WindowRotation.ts
          // finding).
          await rollbackWindowReference(
            tmux.killWindow(server, `${tmuxSession}:${windowName}`),
            paneEnvService,
            tokenId!,
            'restore_rollback',
            () => {
              if (windowRowId) {
                try { windowRepo.remove(windowRowId); } catch (e) {
                  log.warn(`[task-restore] Failed to rollback window row: ${(e as Error).message}`);
                }
              }
            },
            () => {},
          );
        } catch (e) {
          log.warn(`[task-restore] Failed to rollback tmux window: ${(e as Error).message}`);
        }
      } else if (windowRowId) {
        // Defensive fallback only — windowRowId is never set before
        // windowName in the try block above, so this branch should be
        // unreachable in practice.
        try { windowRepo.remove(windowRowId); } catch (e) {
          log.warn(`[task-restore] Failed to rollback window row: ${(e as Error).message}`);
        }
      }
      if (worktreePath && repoDir) {
        try {
          const transport = transportFactory.getTransport(server);
          const worktreeService = worktreeServiceFactory.create(server.type, transport);
          await worktreeService.remove(repoDir, worktreePath);
        } catch (e) {
          log.warn(`[task-restore] Failed to rollback worktree: ${(e as Error).message}`);
        }
      }
      // Issue #29 review, 12th pass, Critical finding 1: same as the
      // ensureSessionWithLock catch above — createRotatedWindow's refetch
      // disagreed with the server row this run's checks ran against, so mark
      // the task failed rather than leaving it at 'archived'.
      if (err instanceof ServerSnapshotMismatchError) {
        if (unitId !== null) appendLogAndEmit(logRepo, events, task.id, unitId, 'command', { type: 'server_snapshot_mismatch', message: err.message });
        taskRepo.update(task.id, { status: 'failed' as TaskStatus } as Partial<Task>);
      }
      throw err;
    }
    });
  }
}
