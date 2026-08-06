import type { IWindowRepository, PaneLayout, Window } from './Window';
import type { ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IServerRepository } from '../servers/Server';
import type { SqliteProjectSecretRepository } from '../projects/SqliteProjectSecretRepository';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IExecutionLogRepository } from '../tasks/ExecutionLog';
import { PathResolverFactory, assertDirectoryContained } from '../git/PathContainment';
import { shellQuote } from '../../shared/shellQuote';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import { shouldSupervise, wrapWithSupervisor } from '../supervisors/SupervisorLaunch';
import type { SessionCaptureService } from './SessionCaptureService';
import { checkExecutionGate, ExecutionGateDeniedError, ExecutionGatePendingApprovalError } from '../tasks/execution/ExecutionGate';
import { resolveExecutionManifest, hashExecutionManifest, type RespawnManifestInput } from '../tasks/execution/ExecutionManifest';
import { appendLogAndEmit } from '../tasks/execution/AppendLog';
import { resolveTmuxSession } from '../tasks/execution/TaskExecutionEnv';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { EventEmitter } from 'events';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the `RespawnManifestInput` (ExecutionManifest.ts) for `win` — the
 * subset of a Window row's fields that decide what a respawn actually
 * launches. Exported (not a private method) because it must be computed
 * TWICE from the exact same Window row for the fingerprint to line up: once
 * here when respawn() itself runs the gate, and once by
 * tasks/execution/ExecutionApprovalDecision.ts's approve-execution handler when it records the approval
 * fingerprint for a blocked 'respawn' operation (Issue #328 eighth-round
 * review finding 2) — a second, slightly-different reimplementation at the
 * approval site is exactly how this class of bug (module doc comment above)
 * keeps recurring, so both call this one function.
 *
 * Mirrors the per-pane worker-type fallback restorePaneLayout()/
 * setupSinglePane() below actually apply when respawning: the first pane
 * inherits `win.workerType` when it has no pane-level override, every other
 * pane has none unless explicitly set.
 */
export function buildRespawnManifestInput(win: Pick<Window, 'serverName' | 'workerModel' | 'workerType' | 'paneLayout'>): RespawnManifestInput {
  if (win.paneLayout) {
    const firstPaneIndex = win.paneLayout.panes[0]?.index;
    return {
      serverName: win.serverName,
      workerModel: win.workerModel,
      panes: win.paneLayout.panes.map((pane) => ({
        index: pane.index,
        workerType: pane.workerType || (pane.index === firstPaneIndex ? win.workerType : null),
      })),
    };
  }
  return {
    serverName: win.serverName,
    workerModel: win.workerModel,
    panes: [{ index: 0, workerType: win.workerType }],
  };
}

interface SupervisionContext {
  supervise: boolean;
  taskId: number | null;
  unitId: number | null;
}

export class WindowRespawnService {
  private readonly pathResolverFactory = new PathResolverFactory();

  constructor(
    private windowRepo: IWindowRepository,
    private tmux: TmuxClient,
    private sessionStrategyFactory: ISessionStrategyFactory,
    private taskRepo: ITaskRepository,
    private unitRepo: IUnitRepository,
    private supervisorRegistry: SupervisorRegistry,
    // projectServerRepo/transportFactory are required, not optional: making
    // them optional previously let respawn() silently skip containment
    // verification whenever a caller forgot to wire them in, even for a
    // project that has an allowedRoot configured — a forgotten-wiring bug
    // would look identical to the legitimate "no boundary configured" case
    // (Issue #27 review Minor finding). They must always be supplied; the
    // only remaining skip path is resolveAllowedRoot() returning null
    // because the *project* has no projectServer.workingDirectory, which is
    // a real "no boundary to enforce" case, not a missing dependency.
    private projectServerRepo: IProjectServerRepository,
    // Required for the same reason projectServerRepo is: resolveExecutionManifest()
    // needs it to resolve project.defaultUnitId / project.defaultBranch the
    // same way ExecuteTaskUseCase/TaskRestoreService do (Issue #328
    // fifth-round review) — without it this service could not fix the gap
    // where a task with no unitId override resolved its Unit differently
    // here (task.unitId directly, ignoring the project default) than every
    // other execution entry point.
    private projectRepo: IProjectRepository,
    private transportFactory: TransportFactory,
    // logRepo is required for the same reason projectServerRepo/transportFactory
    // are (see comment above): the untrusted-input execution gate (Issue #328)
    // must log its blocks the same way ExecuteTaskUseCase/TaskRestoreService
    // do, and making it optional would let a caller silently skip that record.
    private logRepo: IExecutionLogRepository,
    // Required for the same reason projectServerRepo/transportFactory/logRepo
    // are (see comments above): resolveExecutionManifest() needs these to
    // resolve the `sidekick` manifest field the same way PhaseLoopRunner
    // resolves it for an actual run (Issue #328 sixth-round review) — without
    // them the manifest this service hashes would silently omit that field
    // instead of failing to compile.
    private unitTypeLoader: UnitTypeLoader,
    private sidekickLoader: SidekickPackageLoader,
    // Required for the same reason unitTypeLoader/sidekickLoader are (see
    // comments above): resolveExecutionManifest() needs these to resolve
    // the `server.type`/`host`/`agentPort`/`sshHost` and
    // `secrets.namesDigest` manifest fields the same way every other
    // execution entry point does (Issue #328 tenth-round review).
    private serverRepo: IServerRepository,
    private projectSecretRepo: SqliteProjectSecretRepository,
    // Shared task-events EventEmitter (Issue #328 fifteenth-round review) —
    // the SAME instance ExecuteTaskUseCase is constructed with, required for
    // the same reason logRepo is (see its own comment above): a
    // pending_approval block enforceExecutionGate() records must reach
    // buildServer.ts's NotificationBus/push bridges, which subscribe to
    // THIS emitter's 'log' event, not to logRepo.append() rows directly. See
    // AppendLog.ts's appendLogAndEmit() doc comment.
    private events: EventEmitter,
    private sessionCaptureService?: SessionCaptureService,
  ) {}

  async respawn(windowId: number, server: ServerConfig): Promise<{ tmuxTarget: string }> {
    const win = this.windowRepo.findById(windowId);
    if (!win) throw new Error('Window not found');

    const parts = win.tmuxTarget.split(':');
    const sessionName = parts[0];
    const windowPart = parts[1]?.split('.')[0];
    if (!windowPart) throw new Error(`Invalid tmuxTarget: ${win.tmuxTarget}`);

    // Resolve the owning task up front and run the untrusted-input execution
    // gate (Issue #328) before touching tmux or the DB at all — respawn()
    // relaunches a worker exactly like ExecuteTaskUseCase.execute()/
    // TaskRestoreService.restore() do, so an untrusted task that was denied
    // or is pending approval must not be able to resume via respawn (used by
    // both POST /api/windows/:id/respawn and the recover-session fallback in
    // tasks/routes.ts). Windows with no taskId (plain terminals, non-task
    // windows) have no Task.inputTrust to check, so they respawn unchanged.
    // enforceExecutionGate() resolves the Unit itself (via
    // resolveExecutionManifest, same as every other entry point) and returns
    // the resolved id for reuse in the supervision context below — it used
    // to be resolved separately here from task.unitId alone, which silently
    // skipped the project.defaultUnitId fallback every other entry point
    // applies (Issue #328 fifth-round review).
    let task: Task | null = null;
    let unitId: number | null = null;
    if (win.taskId !== null) {
      task = this.taskRepo.findById(win.taskId);
    }
    if (task) {
      unitId = this.enforceExecutionGate(task, server, 'respawn', windowId, buildRespawnManifestInput(win));
    }

    // Resolve and verify every working directory this respawn will `cd`
    // into before touching tmux or the DB at all. Containment verification
    // used to run per-pane inside restorePaneLayout/setupSinglePane, i.e.
    // after the existing window had already been killed, its replacement
    // created, and tmuxTarget persisted — a rejection at that point left a
    // killed window, an empty replacement, and an updated DB row with
    // nothing to show for it (Issue #27 review: destructive half-applied
    // respawn). Resolving here means a rejection throws before any of that
    // happens, leaving the original window and DB row untouched.
    const allowedRoot = this.resolveAllowedRoot(win, server.name);
    const resolvedCwds = await this.resolveAllCwds(server, win, allowedRoot);

    const sessions = await this.tmux.listSessions(server);
    const sessionExists = sessions.some((s) => s.name === sessionName);

    let newName: string;
    if (!sessionExists) {
      // The session's mandatory first window IS the respawn target — creating the
      // session with a generated name and then adding the real window separately
      // would strand that first window as an unmanaged bare shell.
      newName = (await this.tmux.createSession(server, sessionName, { windowName: windowPart, exactName: true })).windowName;
      await sleep(500);
    } else {
      const session = sessions.find((s) => s.name === sessionName);
      const windowAlive = session?.windows.some((w) => w.name === windowPart);
      if (windowAlive) {
        await this.tmux.killWindow(server, `${sessionName}:${windowPart}`).catch(() => {});
      }
      newName = (await this.tmux.createWindow(server, sessionName, windowPart, { exactName: true })).windowName;
      await sleep(300);
    }

    const baseTarget = `${sessionName}:${newName}`;
    const dbTarget = `${baseTarget}.1`;

    this.windowRepo.update(windowId, { tmuxTarget: dbTarget });

    const supervise = shouldSupervise(server.type, win.windowType);
    // task/unitId already resolved above for the execution gate — reused
    // here instead of re-querying the repositories a second time.
    const supervision: SupervisionContext = { supervise, taskId: win.taskId, unitId };

    if (win.paneLayout) {
      await this.restorePaneLayout(server, baseTarget, win.paneLayout, win, supervision, resolvedCwds.paneCwds);
    } else {
      const paneId = await this.tmux.resolvePaneId(server, baseTarget);
      await this.setupSinglePane(server, paneId, baseTarget, win, supervision, resolvedCwds.singleCwd);
    }

    return { tmuxTarget: dbTarget };
  }

  /**
   * Runs the untrusted-input execution gate (Issue #328) for the task that
   * owns this window and, when it blocks, records the same log entry
   * ExecuteTaskUseCase.enforceExecutionGate()/TaskRestoreService.restore()
   * use, then throws before the caller proceeds to any tmux mutation.
   * Resolves the manifest (and the Unit it covers) itself via
   * resolveExecutionManifest() — same as those other two entry points —
   * and returns the resolved Unit id so the caller can reuse it for the
   * supervision context instead of re-resolving (or under-resolving:
   * this used to read `task.unitId` directly here, which skips the
   * project.defaultUnitId fallback every other entry point applies; Issue
   * #328 fifth-round review). Returns `null` when the task has no
   * resolvable Unit (e.g. task.unitId points at a deleted Unit) — the block
   * still throws in that case, it just has no unit to attach a log entry to.
   *
   * `operation`/`windowId` record WHICH blocked entry point this was, in
   * task.pendingOperation/pendingOperationWindowId, so the approval handler
   * (modules/tasks/execution/ExecutionApprovalDecision.ts's approve-execution) can resume the exact
   * operation a human approved (Issue #328 fourth-round review finding 2:
   * this method used to only call `taskRepo.updateStatus(..., 'pending_
   * approval')`, recording no operation at all — approving a blocked
   * respawn/legacy-recover then fell into the *other* gates' NULL-fallback
   * heuristic and silently resumed the wrong operation, e.g. resuming the
   * state machine instead of actually respawning the window). `windowId` is
   * only meaningful for `'respawn'` — resumeLegacySession() has no Window
   * row to record, so it always passes `null` (see Task.pendingOperation's
   * write-site catalogue).
   *
   * `respawnInput` (built by buildRespawnManifestInput() above from the
   * Window actually being respawned) is folded into the resolved manifest
   * before hashing so the fingerprint covers what THIS respawn will really
   * launch (target server, worker model, per-pane worker types) — not just
   * what task/Unit resolution alone would produce, which can diverge when a
   * stale Window still lives on a different server than the task now
   * resolves to (Issue #328 eighth-round review finding 2). Omitted (kept
   * `undefined`) for `'recover_session_legacy'`, which has no Window row and
   * whose target server already comes from the same resolveTaskServerName()
   * call the manifest itself uses (tasks/execution/ExecutionApprovalDecision.ts's approve-execution
   * dispatch), so there is nothing to diverge from.
   */
  private enforceExecutionGate(
    task: Task,
    server: ServerConfig,
    operation: 'respawn' | 'recover_session_legacy',
    windowId: number | null,
    respawnInput?: RespawnManifestInput,
  ): number | null {
    // `server` here is the ACTUAL server this respawn/legacy-recover will
    // run on (respawn()/resumeLegacySession() both resolve it from the
    // Window/task before calling in — see their call sites above) — not
    // necessarily the server the task itself resolves to (see
    // resolveExecutionManifest's `serverNameOverride` doc comment for why
    // the two can diverge and what happens if this override is dropped).
    // Passing it through is what makes checkExecutionGate below read the
    // input policy for the server respawn will really touch.
    const { manifest, unit, projectServer } = resolveExecutionManifest(task, {
      unitRepo: this.unitRepo,
      projectRepo: this.projectRepo,
      projectServerRepo: this.projectServerRepo,
      serverRepo: this.serverRepo,
      projectSecretRepo: this.projectSecretRepo,
      unitTypeLoader: this.unitTypeLoader,
      sidekickLoader: this.sidekickLoader,
    }, respawnInput, server.name);
    const unitId = unit?.id ?? null;
    const gate = checkExecutionGate(task, projectServer, hashExecutionManifest(manifest));
    if (gate.allowed) return unitId;

    if (unitId !== null) {
      appendLogAndEmit(this.logRepo, this.events, task.id, unitId, 'command', { type: 'execution_gate_blocked', reason: gate.reason });
    }
    if (gate.reason === 'pending_approval') {
      this.taskRepo.update(task.id, {
        status: 'pending_approval',
        pendingOperation: operation,
        pendingOperationWindowId: windowId,
        pendingOperationPriorStatus: task.status,
      } as Partial<Task>);
      // A 'status_change' entry, not just the 'command' entry above, is what
      // buildServer.ts's NotificationBus/push bridges turn into a live
      // browser notification (same reasoning as
      // ExecuteTaskUseCase.enforceExecutionGate / TaskRestoreService.restore
      // — see AppendLog.ts's appendLogAndEmit() doc comment). Before Issue
      // #328 fifteenth-round review this method recorded ONLY the 'command'
      // entry above — a respawn or legacy-recover blocked here left the task
      // at pending_approval with no notification ever reaching a human, the
      // one entry point that had never even attempted the status_change log
      // the other two entry points wrote (just to an unwired destination).
      if (unitId !== null) {
        appendLogAndEmit(this.logRepo, this.events, task.id, unitId, 'status_change', { status: 'pending_approval', operation });
      }
      throw new ExecutionGatePendingApprovalError(task.id);
    }
    // 'denied': leave task status untouched — same rationale as the other
    // two enforcement sites (nothing to roll back, a human must change the
    // project server's input_policy before a retry can succeed).
    throw new ExecutionGateDeniedError(task.id);
  }

  /**
   * Legacy recovery path for tasks that predate Window records (migration
   * 034): creates a fresh tmux window and launches `claude --resume
   * <agentSessionId>` directly, with no Window row involved — respawn()
   * doesn't apply here since there is no window to respawn. Lives on this
   * service (not inline in tasks/routes.ts, where it originated) so both
   * the recover-session route's fallback branch and the approve-execution
   * handler resuming a blocked 'recover_session_legacy' pendingOperation
   * share one implementation instead of two copies of the same tmux/
   * supervisor wiring drifting apart (Issue #328 fourth-round review).
   * Re-resolves the task from the DB itself (like respawn() does for its
   * window) rather than taking one as a parameter, so a caller can never
   * pass a stale object whose executionApprovedFingerprintHash predates a
   * just-recorded approval — see the matching fix in TaskRestoreService's
   * caller for the bug this pattern avoids.
   */
  async resumeLegacySession(taskId: number, server: ServerConfig): Promise<{ windowName: string }> {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!task.agentSessionId) throw new Error(`Task ${taskId} has no agent session ID`);

    this.enforceExecutionGate(task, server, 'recover_session_legacy', null);

    const tmuxSession = resolveTmuxSession(task.projectId, server.name, this.projectServerRepo);
    const { windowName } = await this.tmux.createWindow(server, tmuxSession, `task-${task.id}`);
    const windowTarget = `${tmuxSession}:${windowName}`;
    const paneId = await this.tmux.resolvePaneId(server, windowTarget);
    const resumeCommand = `claude --resume ${task.agentSessionId} --dangerously-skip-permissions`;
    const isSupervised = shouldSupervise(server.type, 'agent');
    if (isSupervised) {
      this.supervisorRegistry.clearExitMarker(server.name, windowTarget);
    }
    const sendCmd = isSupervised
      ? wrapWithSupervisor(resumeCommand, { server, target: windowTarget, taskId: task.id, unitId: task.unitId ?? undefined })
      : resumeCommand;
    await this.tmux.sendKeys(server, paneId, [sendCmd, 'Enter']);
    this.taskRepo.update(taskId, { tmuxWindow: windowName } as Partial<Task>);
    return { windowName };
  }

  /**
   * Resolves the project's configured working directory (the containment
   * boundary — see PathContainment.ts) for the window being respawned, or
   * `null` when it can't be determined. `null` means "no boundary to
   * enforce" and the caller must skip verification, same as
   * ExecuteTaskUseCase/TaskRestoreService do when a project has no
   * projectServer.workingDirectory configured — this must never be treated
   * as "verification failed" (Issue #27 review finding 1).
   */
  private resolveAllowedRoot(win: Window, serverName: string): string | null {
    let projectId = win.projectId;
    if (projectId === null && win.taskId !== null) {
      const task = this.taskRepo.findById(win.taskId);
      projectId = task?.projectId ?? null;
    }
    if (projectId === null) return null;
    return this.projectServerRepo.find(projectId, serverName)?.workingDirectory || null;
  }

  /**
   * Verifies `cwd` stays within `allowedRoot` and returns the resolved
   * (symlink-free) path to `cd` into — mirrors ExecuteTaskUseCase's TOCTOU
   * fix (Issue #27 review finding 2): using `cwd` again after verification,
   * instead of the resolved value this returns, would leave the same
   * symlink-swap window open. Skips (returns `cwd` unchanged) when
   * `allowedRoot` is unset — i.e. the project has no containment boundary
   * configured, not because a dependency is missing (both `transportFactory`
   * and `projectServerRepo` are required constructor dependencies).
   */
  private async resolveContainedCwd(server: ServerConfig, cwd: string, allowedRoot: string | null, label: string): Promise<string> {
    if (!allowedRoot) return cwd;
    const transport = this.transportFactory.getTransport(server);
    return assertDirectoryContained(this.pathResolverFactory, server.type, transport, { target: cwd, allowedRoot }, label);
  }

  /**
   * Resolves and verifies every working directory a respawn will `cd` into,
   * up front — see the ordering comment in respawn(). Mirrors exactly what
   * restorePaneLayout/setupSinglePane used to compute inline, just moved
   * ahead of the kill/create/persist sequence; the per-pane "fail fast"
   * rationale (a rejected cwd aborts the whole respawn) is unchanged.
   */
  private async resolveAllCwds(
    server: ServerConfig,
    win: { workingDirectory: string | null; paneLayout: PaneLayout | null },
    allowedRoot: string | null,
  ): Promise<{ paneCwds: Map<number, string>; singleCwd: string | null }> {
    if (win.paneLayout) {
      const paneCwds = new Map<number, string>();
      for (const pane of win.paneLayout.panes) {
        const rawCwd = pane.workingDirectory || win.workingDirectory;
        if (rawCwd) {
          const cwd = await this.resolveContainedCwd(server, rawCwd, allowedRoot, 'pane working directory');
          paneCwds.set(pane.index, cwd);
        }
      }
      return { paneCwds, singleCwd: null };
    }
    if (win.workingDirectory) {
      const singleCwd = await this.resolveContainedCwd(server, win.workingDirectory, allowedRoot, 'window working directory');
      return { paneCwds: new Map(), singleCwd };
    }
    return { paneCwds: new Map(), singleCwd: null };
  }

  private wrapIfSupervised(cmd: string, server: ServerConfig, supervisorTarget: string, supervision: SupervisionContext): string {
    if (!supervision.supervise) return cmd;
    this.supervisorRegistry.clearExitMarker(server.name, supervisorTarget);
    return wrapWithSupervisor(cmd, {
      server,
      target: supervisorTarget,
      taskId: supervision.taskId ?? undefined,
      unitId: supervision.unitId ?? undefined,
    });
  }

  async capturePaneLayout(server: ServerConfig, tmuxTarget: string): Promise<PaneLayout> {
    const windowTarget = tmuxTarget.includes('.') ? tmuxTarget.split('.')[0] : tmuxTarget;

    const layoutResult = await this.tmux.execCommand(
      server,
      `tmux display-message -t '${windowTarget}' -p '#{window_layout}'`,
    );
    const layout = layoutResult.stdout.trim();

    const paneResult = await this.tmux.execCommand(
      server,
      `tmux list-panes -t '${windowTarget}' -F '#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}'`,
    );

    const panes = paneResult.stdout.trim().split('\n').map((line) => {
      const [index, command, workingDirectory, title] = line.split('\t');
      return {
        index: parseInt(index, 10),
        command: command || null,
        workingDirectory: workingDirectory || null,
        title: title || null,
      };
    });

    return { layout, panes };
  }

  private async restorePaneLayout(
    server: ServerConfig,
    baseTarget: string,
    paneLayout: PaneLayout,
    win: { workerType: string | null; agentSessionId: string | null; workerModel: string | null; workingDirectory: string | null },
    supervision: SupervisionContext,
    paneCwds: Map<number, string>,
  ): Promise<void> {
    const paneCount = paneLayout.panes.length;
    const firstPaneId = await this.tmux.resolvePaneId(server, baseTarget);
    for (let i = 1; i < paneCount; i++) {
      await this.tmux.splitPane(server, firstPaneId, i % 2 === 0 ? 'v' : 'h');
      await sleep(200);
    }

    if (paneLayout.layout) {
      await this.tmux.execCommand(
        server,
        `tmux select-layout -t '${baseTarget}' '${paneLayout.layout}'`,
      );
    }

    const paneIdMap = new Map<number, string>();
    const paneEntries = await this.tmux.listPaneIds(server, baseTarget);
    for (const entry of paneEntries) {
      paneIdMap.set(entry.index, entry.paneId);
    }

    for (const pane of paneLayout.panes) {
      const paneId = paneIdMap.get(pane.index);
      if (!paneId) continue;
      // Already resolved and containment-checked by resolveAllCwds() before
      // any destructive tmux operation ran — a missing entry here means the
      // pane had no workingDirectory to begin with, not a rejected one (a
      // rejection would have thrown out of respawn() earlier).
      const cwd = paneCwds.get(pane.index);
      if (cwd) {
        // cwd is a resolved (symlink-free) real path — must be shell-quoted
        // before being typed into the pane (Issue #27 cd injection).
        await this.tmux.sendKeys(server, paneId, [`cd -- ${shellQuote(cwd)}`, 'Enter']);
        await sleep(300);
      }

      const workerType = pane.workerType || (pane.index === paneLayout.panes[0]?.index ? win.workerType : null);
      const sessionId = pane.agentSessionId || (pane.index === paneLayout.panes[0]?.index ? win.agentSessionId : null);
      if (workerType) {
        const strategy = this.sessionStrategyFactory.create(workerType);
        const cmd = strategy.buildRespawnCommand(sessionId, win.workerModel, null);
        if (cmd) {
          const sendCmd = this.wrapIfSupervised(cmd, server, baseTarget, supervision);
          await this.tmux.sendKeys(server, paneId, [sendCmd, 'Enter']);
        }
      }
    }
  }

  private async setupSinglePane(
    server: ServerConfig,
    paneId: string,
    supervisorTarget: string,
    win: { id?: number; workerType: string | null; agentSessionId: string | null; workerModel: string | null; workingDirectory: string | null },
    supervision: SupervisionContext,
    singleCwd: string | null,
  ): Promise<void> {
    if (singleCwd) {
      // singleCwd is a resolved (symlink-free) real path, already
      // containment-checked by resolveAllCwds() before any destructive tmux
      // operation ran — must be shell-quoted before being typed into the
      // pane (Issue #27 cd injection).
      await this.tmux.sendKeys(server, paneId, [`cd -- ${shellQuote(singleCwd)}`, 'Enter']);
      await sleep(300);
    }

    if (win.workerType) {
      let sessionId = win.agentSessionId;
      if (!sessionId && win.id != null && this.sessionCaptureService) {
        sessionId = await this.sessionCaptureService.tryScanForWindow(win.id);
      }
      const strategy = this.sessionStrategyFactory.create(win.workerType);
      const cmd = strategy.buildRespawnCommand(sessionId, win.workerModel, null);
      if (cmd) {
        const sendCmd = this.wrapIfSupervised(cmd, server, supervisorTarget, supervision);
        await this.tmux.sendKeys(server, paneId, [sendCmd, 'Enter']);
      }
    }
  }
}
