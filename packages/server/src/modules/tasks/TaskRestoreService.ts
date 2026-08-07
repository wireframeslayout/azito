import type { ITaskRepository, Task } from './Task';
import type { TaskStatus } from './TaskStatus';
import type { IServerRepository } from '../servers/Server';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IUnitRepository } from '../units/Unit';
import type { IWindowRepository } from '../windows/Window';
import type { SqliteProjectSecretRepository } from '../projects/SqliteProjectSecretRepository';
import type { TmuxClient } from '../tmux/TmuxClient';
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
}

export class TaskRestoreService {
  private readonly pathResolverFactory = new PathResolverFactory();

  constructor(private deps: TaskRestoreDeps) {}

  async restore(task: Task, log: { warn: (msg: string) => void }): Promise<{ tmuxTarget: string; worktreePath: string | null }> {
    const { taskRepo, serverRepo, projectRepo, projectServerRepo, unitRepo, windowRepo, tmux, worktreeServiceFactory, transportFactory, contentExtractor, logRepo, unitTypeLoader, sidekickLoader, projectSecretRepo, events } = this.deps;

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
      await tmux.createSession(server, tmuxSession, {});
      await sleep(500);
    }

    let windowName: string | null = null;
    let worktreePath: string | null = null;
    let windowRowId: number | null = null;
    let repoDir: string | null = null;

    try {
      const created = await tmux.createWindow(server, tmuxSession, `task-${task.id}`);
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
        // worktreeBranch first (Issue #328 review round): ExecuteTaskUseCase/
        // PhaseLoopRunner no longer echo the system-resolved branch back into
        // task.branch after a run (that write was the execution-gate
        // fingerprint self-invalidation bug — see ExecuteTaskUseCase.execute's
        // worktree-creation comment), so worktreeBranch is now the only field
        // that reliably reflects "which branch did this task's prior run
        // actually use" — task.branch stays whatever branch name (if any) the
        // client originally specified. Restoring into the SAME branch a prior
        // run created means preferring worktreeBranch when both are set.
        const branch = task.worktreeBranch || task.branch || undefined;
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

      taskRepo.update(task.id, {
        status: 'open' as TaskStatus,
        tmuxWindow: windowName,
        worktreePath,
        worktreeBranch,
        baseBranch,
        branch: worktreeBranch,
        pendingOperation: null,
      } as Partial<Task>);

      return { tmuxTarget: dbTarget, worktreePath };
    } catch (err) {
      if (windowName) {
        try { await tmux.killWindow(server, `${tmuxSession}:${windowName}`); } catch (e) {
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
