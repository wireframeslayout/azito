import type { ITaskRepository, Task } from './Task';
import type { TaskStatus } from './TaskStatus';
import type { IServerRepository } from '../servers/Server';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IUnitRepository } from '../units/Unit';
import type { IWindowRepository } from '../windows/Window';
import type { SqliteProjectSecretRepository } from '../projects/SqliteProjectSecretRepository';
import type { TmuxClient } from '../tmux/TmuxClient';
import { resolveKillOutcome } from '../tmux/killOutcome';
import { createRotatedWindow } from './execution/WindowRotation';
import type { WorktreeServiceFactory } from '../git/WorktreeServiceFactory';
import { PathResolverFactory, assertDirectoryContained } from '../git/PathContainment';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IContentExtractor } from '../llm/ContentExtractor';
import type { IExecutionLogRepository } from './ExecutionLog';
import { resolveTaskServerName, resolveTmuxSession, resolveBaseBranch } from './execution/TaskExecutionEnv';
import { buildWorkerLaunchCommand } from '../agents/LaunchCommand';
import { shellQuote } from '../../shared/shellQuote';
import { checkExecutionGate, ExecutionGateDeniedError, ExecutionGatePendingApprovalError } from './execution/ExecutionGate';
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
}

export class TaskRestoreService {
  private readonly pathResolverFactory = new PathResolverFactory();

  constructor(private deps: TaskRestoreDeps) {}

  async restore(task: Task, log: { warn: (msg: string) => void }): Promise<{ tmuxTarget: string; worktreePath: string | null }> {
    const { taskRepo, serverRepo, projectRepo, projectServerRepo, unitRepo, windowRepo, tmux, worktreeServiceFactory, transportFactory, contentExtractor, logRepo, unitTypeLoader, sidekickLoader, projectSecretRepo, events, paneEnvService } = this.deps;

    const serverName = resolveTaskServerName(task, projectServerRepo);
    if (!serverName) {
      throw new Error('Cannot resolve server: task has no serverName and its project does not have exactly one project_servers entry');
    }

    const server = serverRepo.findByName(serverName);
    if (!server) {
      throw new Error(`Server '${serverName}' not found`);
    }

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
    const gate = checkExecutionGate(task, projectServer, manifestHash);
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

    const existingSessions = await tmux.listSessions(server);
    const sessionExists = existingSessions.some((s) => s.name === tmuxSession);
    if (!sessionExists) {
      // Throwaway bootstrap window — the real task window is created just
      // below via createWindow, which is what actually gets AZITO_TASK_TOKEN
      // (see the comment there and TaskPaneEnvironmentService's own doc
      // comment).
      await tmux.createSession(server, tmuxSession, { extraEnv: {} });
      await sleep(500);
    }

    let windowName: string | null = null;
    let worktreePath: string | null = null;
    let windowRowId: number | null = null;
    let repoDir: string | null = null;

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
      const created = await createRotatedWindow(paneEnvService, server, task, 'restore_create_failed', (env) =>
        tmux.createWindow(server, tmuxSession, `task-${task.id}`, { extraEnv: env }),
      );
      windowName = created.windowName;

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
        baseBranch = resolveBaseBranch(task, projectServer, project);
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
        const branch = task.branch || task.worktreeBranch || undefined;
        const slug = branch ? `task-${task.id}` : await contentExtractor.generateSlug(task.title);

        const transport = transportFactory.getTransport(server);
        const worktreeService = worktreeServiceFactory.create(server.type, transport);
        const wt = await worktreeService.create(workingDir, task.id, slug, baseBranch, branch);
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
          // resolveKillOutcome normalizes local (throws on failure) vs agent
          // (resolves with a non-zero code) transports into one verdict —
          // see its doc comment; a bare await here previously read an
          // agent-transport kill failure as success (Issue #28 third-party
          // review finding 2).
          const outcome = await resolveKillOutcome(tmux.killWindow(server, `${tmuxSession}:${windowName}`));
          // The createWindow() above (line ~177) already rotated the task
          // token for THIS window generation via buildEnvForNewWindow. The
          // task's status stays 'archived' throughout this rollback (no
          // taskRepo.update touches status here) — 'archived' IS in
          // TOKEN_REVOKING_STATUSES, but that revocation already fired back
          // when the task was originally archived, before this restore
          // attempt; no status WRITE happens on this failure path to trigger
          // it again for the freshly-issued generation. Revoke it directly,
          // same fix as ExecuteTaskUseCase's rollback branches (Issue #28
          // third-party review finding) — only once the kill above confirms
          // the window is actually gone.
          if (outcome.success) {
            paneEnvService.revokeForDestroyedWindow(task.id, 'restore_rollback');
          }
        } catch (e) {
          log.warn(`[task-restore] Failed to rollback tmux window: ${(e as Error).message}`);
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
      if (windowRowId) {
        try { windowRepo.remove(windowRowId); } catch (e) {
          log.warn(`[task-restore] Failed to rollback window row: ${(e as Error).message}`);
        }
      }
      throw err;
    }
  }
}
