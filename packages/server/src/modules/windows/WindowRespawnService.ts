import { isPrimaryTaskWindow, type IWindowRepository, type PaneLayout, type Window } from './Window';
import type { ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import { resolveEffectiveInputPolicy } from '../projects/ProjectServer';
import type { IServerRepository } from '../servers/Server';
import type { SqliteProjectSecretRepository } from '../projects/SqliteProjectSecretRepository';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IExecutionLogRepository } from '../tasks/ExecutionLog';
import { PathResolverFactory, assertDirectoryContained } from '../git/PathContainment';
import { shellQuote } from '../../shared/shellQuote';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import { shouldSupervise, wrapWithSupervisor } from '../supervisors/SupervisorLaunch';
import type { SessionCaptureService } from './SessionCaptureService';
import { checkExecutionGate, ExecutionGateDeniedError, ExecutionGatePendingApprovalError, reverifyExecutionGateInLock } from '../tasks/execution/ExecutionGate';
import { resolveExecutionManifest, hashExecutionManifest, type RespawnManifestInput } from '../tasks/execution/ExecutionManifest';
import { appendLogAndEmit } from '../tasks/execution/AppendLog';
import type { TaskPaneEnvironmentService } from '../tasks/execution/TaskPaneEnvironmentService';
import { resolveTmuxSession } from '../tasks/execution/TaskExecutionEnv';
import {
  confirmOldWindowGone,
  createPlainWindowInLock,
  createRotatedWindow,
  createRotatedWindowInLock,
  createSecondaryWindowInLock,
  rollbackWindowReference,
  runExclusiveForTask,
  withServerLock,
  type ServerIsolationLock,
} from '../tasks/execution/WindowRotation';
import type { KeyedMutex } from '../../shared/keyedMutex';
import { resolveKillOutcome } from '../tmux/killOutcome';
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
    // Issue #28 Phase A後半: the sole task-pane env builder — see
    // TaskPaneEnvironmentService's own doc comment. respawn()'s
    // window-(re)creation calls (both branches — session exists or not) and
    // resumeLegacySession() all go through this now; a plain (non-task)
    // window respawn instead falls back to TmuxClient.uiTokenEnv() (see
    // resolveRespawnEnv() below).
    private paneEnvService: TaskPaneEnvironmentService,
    // Issue #29 review (7th pass), Important finding 1: the SAME
    // per-server-name mutex `modules/servers/routes.ts`'s PUT handler and
    // `modules/tmux/routes/sessions.ts`'s manual window/pane routes already
    // serialize the isolation false->true transition against (see that
    // mutex's own doc comment) — required (placed before the optional
    // sessionCaptureService below, not after, so it stays a required
    // parameter), so respawn()/resumeLegacySession() can never build a
    // window env from a `server` a concurrent transition has already
    // superseded. See ServerIsolationLock's doc comment in WindowRotation.ts.
    private serverIsolationMutex: KeyedMutex,
    // Issue #29 Step 3a: same flag ExecuteTaskUseCase/PhaseLoopRunner/
    // TaskRestoreService are constructed with — enforceExecutionGate() below
    // needs it for resolveEffectiveInputPolicy(). Placed before the optional
    // sessionCaptureService (required params must precede optional ones).
    private scopedAuthEnabled: boolean,
    private sessionCaptureService?: SessionCaptureService,
  ) {}

  private get serverIsolationLock(): ServerIsolationLock {
    return { serverIsolationMutex: this.serverIsolationMutex, serverRepo: this.serverRepo };
  }

  async respawn(windowId: number, server: ServerConfig): Promise<{ tmuxTarget: string }> {
    const win = this.windowRepo.findById(windowId);
    if (!win) throw new Error('Window not found');

    // Validated once here for a fast, early failure on an obviously-corrupt
    // row — the ACTUAL session/window names `rotate` below acts on are
    // re-read fresh from the DB inside the lock (see the comment on that
    // re-read for why: this initial `win` snapshot can go stale while this
    // call sits queued behind another rotation for the same task).
    if (!win.tmuxTarget.split(':')[1]?.split('.')[0]) throw new Error(`Invalid tmuxTarget: ${win.tmuxTarget}`);

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

    // Whether `win` is the task's PRIMARY worker window — the only window a
    // task token generation is bound to (Issue #28 third-party review
    // finding: a secondary window, added via POST /api/tasks/:id/windows,
    // must never rotate or revoke that token — see isPrimaryTaskWindow's doc
    // comment on windows/Window.ts). `task` is required in addition to the
    // window-row check: a window whose owning task was deleted (task is
    // null) has nothing to rotate either.
    const isPrimary = task !== null && isPrimaryTaskWindow(win);

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

    const supervise = shouldSupervise(server.type, win.windowType);
    // task/unitId already resolved above for the execution gate — reused
    // here instead of re-querying the repositories a second time.
    const supervision: SupervisionContext = { supervise, taskId: win.taskId, unitId };

    // Window-generation point for this window: EITHER branch below actually
    // (re)creates the window that becomes the respawned pane (unlike
    // ExecuteTaskUseCase's throwaway-session-then-real-window split, respawn
    // has no separate bootstrap step — whichever tmux call runs here IS the
    // respawn target). Only the task's PRIMARY worker window rotates its
    // task token via TaskPaneEnvironmentService (createRotatedWindow, which
    // also rolls the new generation back on a creation failure — whether
    // thrown or resolved with a non-zero exit code, see WindowRotation.ts);
    // a secondary task window gets a masked-only env (buildEnvForSecondaryWindow
    // — never a task token, never rotates/revokes) and a plain (non-task)
    // window keeps getting the legacy default UI-token env instead — neither
    // has a generation to roll back (Issue #28 design v3 §3/§5 only scope
    // task panes; the third-party review's multi-window finding further
    // scopes the token itself to the primary window alone — see
    // isPrimaryTaskWindow's doc comment). The rotation itself only happens
    // once the old window's demise is confirmed above, so the primary pane
    // is never left holding a revoked token for a window that, in fact,
    // survived the kill attempt.
    //
    // The whole listSessions -> confirm-kill -> rotate-token -> create ->
    // pane-restore -> final-persist span runs INSIDE ONE per-task lock
    // callback when this window belongs to a task (Issue #28 third-party
    // review, design v3 §2 — see runExclusiveForTask's doc comment in
    // WindowRotation.ts). This used to be split: session/window liveness was
    // read ONCE, before the lock was even queued for, and pane restoration
    // ran AFTER the lock released — Phase C round-4 review, Important
    // finding. Two concrete bugs came from that split:
    //   1. TOCTOU on `windowAlive` — a second respawn queued behind this one
    //      still decided "is the old window alive?" from a snapshot taken
    //      before EITHER call started. Concretely: call A creates its new
    //      window and persists it; call B, still holding its stale
    //      `windowAlive=false` from before A ran, skips confirmOldWindowGone
    //      entirely (nothing to kill, as far as B's stale snapshot is
    //      concerned) and creates its own window anyway — but
    //      createRotatedWindow's buildEnvForNewWindow ALWAYS revokes the
    //      task's current generation when issuing a new one, so B's rotation
    //      revokes A's still-live window's token without ever killing that
    //      window. A's pane is now orphaned: alive, unreachable via the API,
    //      and holding a dead credential.
    //   2. Pane restoration racing the NEXT queued rotation — with restore
    //      outside the lock, call B's rotate() (queued behind A) could start
    //      as soon as A's rotate() resolved, while A's own restorePaneLayout/
    //      setupSinglePane was still sending keys into A's pane.
    // Re-reading session/window state HERE (fresh, at the moment this
    // specific queued turn actually runs) and moving pane restoration inside
    // the same lock callback closes both gaps: every respawn for a task now
    // owns the window's entire kill-through-restore lifecycle atomically
    // before the next queued rotation for that task can begin. A window with
    // no owning task has no generation to protect and no concurrent rotation
    // to race, so it still runs unlocked.
    const run = async (): Promise<{ tmuxTarget: string }> => {
      // Re-read the window's CURRENT tmuxTarget from the DB inside the lock
      // (mirrors ExecuteTaskUseCase's `currentTask` re-read — see its own
      // comment on the TOCTOU this closes): a prior queued rotation for this
      // task may have already replaced this window's session/window name by
      // the time this turn actually runs, and `win` (captured once, before
      // this call was even queued) would not reflect that.
      const currentWin = this.windowRepo.findById(windowId);
      if (!currentWin) throw new Error('Window not found');
      const curParts = currentWin.tmuxTarget.split(':');
      const sessionName = curParts[0];
      const windowPart = curParts[1]?.split('.')[0];
      if (!windowPart) throw new Error(`Invalid tmuxTarget: ${currentWin.tmuxTarget}`);

      // Issue #29 review, 14th pass, Important finding 1: the per-server
      // isolation lock is now acquired — and `server`'s snapshot verified
      // against the freshly re-read row — BEFORE the old window is killed,
      // not after. This used to list sessions and run confirmOldWindowGone
      // (which KILLS the old window) against the `server` argument from
      // before this call was even queued for the lock, and only reached the
      // lock+snapshot-check afterwards, inside createRotatedWindow/
      // createSecondaryWindow/createPlainWindow — so a mismatch (isolation
      // flipped, connection info swapped mid-flight) aborted AFTER the old
      // window was already dead, leaving the Window row pointing at a
      // now-killed target with no replacement ever created. `withServerLock`
      // performs the lock+refetch+snapshot-check first; the kill, the
      // create-vs-createSession decision (via `doCreate`, which re-lists
      // sessions again from `freshServer` — Issue #29 review, 9th pass,
      // Important finding 2, still honored here), and the window creation
      // itself all run inside its callback, against the SAME `freshServer`
      // row throughout.
      let createdViaNewSession = false;
      const {
        newName,
        windowEnv,
        tokenId,
        server: respawnServer,
      } = await withServerLock(this.serverIsolationLock, server, true, async (freshServer) => {
        // Issue #29 Step 3a review round, Important finding 2: re-verify the
        // untrusted-execution gate against `freshServer` — re-read once this
        // lock is actually acquired — BEFORE confirmOldWindowGone below kills
        // the existing primary window, not after. This used to run only
        // inside createRotatedWindowInLock's preCheck, which fires
        // immediately before the new window's task token/env is built —
        // i.e. AFTER the old window was already destroyed. A downgrade
        // discovered there still aborted the respawn, but by then the task's
        // only working pane was already gone: the caller was left at
        // pending_approval with no window at all, instead of the still-live
        // pre-respawn window an in-lock block is supposed to leave
        // untouched. Moving the same check here means a downgrade aborts
        // before anything is torn down.
        if (isPrimary) {
          // 'continuation': a respawn resumes a task whose working
          // directory a past execute()/restore() already populated — it
          // never distributes anything itself.
          const { manifest, projectServer: freshProjectServer } = resolveExecutionManifest(task!, {
            unitRepo: this.unitRepo,
            projectRepo: this.projectRepo,
            projectServerRepo: this.projectServerRepo,
            serverRepo: this.serverRepo,
            projectSecretRepo: this.projectSecretRepo,
            unitTypeLoader: this.unitTypeLoader,
            sidekickLoader: this.sidekickLoader,
          }, 'continuation', buildRespawnManifestInput(currentWin), freshServer.name);
          reverifyExecutionGateInLock(
            { taskRepo: this.taskRepo, logRepo: this.logRepo, events: this.events },
            task!,
            unitId,
            'respawn',
            freshProjectServer,
            freshServer,
            this.scopedAuthEnabled,
            hashExecutionManifest(manifest),
            windowId,
          );
        }

        const sessions = await this.tmux.listSessions(freshServer);
        const sessionExists = sessions.some((s) => s.name === sessionName);
        const session = sessions.find((s) => s.name === sessionName);
        const windowAlive = sessionExists && (session?.windows.some((w) => w.name === windowPart) ?? false);

        // Confirm the old window is actually gone BEFORE rotating the task
        // token (Issue #28 third-party review finding 3), via the same
        // shared operation execute()/followUp() now use (WindowRotation.ts)
        // — buildEnvForNewWindow() revokes the current token generation and
        // issues a new one, so calling it while the old window might still
        // be alive (a killWindow() failure was previously swallowed via
        // `.catch(() => {})`) could leave that still-live pane holding a
        // now-dead credential.
        await confirmOldWindowGone(
          this.tmux,
          freshServer,
          windowAlive ? { target: `${sessionName}:${windowPart}`, kind: 'window' } : null,
          isPrimary ? task!.id : null,
        );

        createdViaNewSession = !sessionExists;
        const doCreate = async (fs: ServerConfig, env: Record<string, string>) => {
          // Re-lists sessions from `fs` (Issue #29 review, 9th pass,
          // Important finding 2) rather than trusting `sessionExists`
          // above: `fs` here is the SAME `freshServer` the outer lock
          // already re-read, but re-checking immediately before the actual
          // create call keeps this decision resilient to a session
          // teardown/creation racing between the two reads within the same
          // lock turn.
          const freshSessions = await this.tmux.listSessions(fs);
          const freshSessionExists = freshSessions.some((s) => s.name === sessionName);
          createdViaNewSession = !freshSessionExists;
          return !freshSessionExists
            ? this.tmux.createSession(fs, sessionName, { windowName: windowPart, exactName: true, extraEnv: env })
            : this.tmux.createWindow(fs, sessionName, windowPart, { exactName: true, extraEnv: env });
        };

        if (isPrimary) {
          // No preCheck here — the same reverify already ran above, before
          // confirmOldWindowGone, against this same `freshServer` snapshot
          // (see the comment at the top of this lock callback).
          const created = await createRotatedWindowInLock(this.paneEnvService, freshServer, task!, 'respawn_create_failed', doCreate);
          return { newName: created.windowName, windowEnv: created.env, tokenId: created.tokenId as number | null, server: created.server };
        } else if (task) {
          const created = await createSecondaryWindowInLock(this.paneEnvService, freshServer, task, doCreate);
          return { newName: created.windowName, windowEnv: created.env, tokenId: null as number | null, server: created.server };
        } else {
          // Non-task window respawn — server-aware legacy default (Issue #29
          // review, Critical finding 1): withholds the token when the server
          // is declared isolated, same as the manual session/window/pane
          // routes. Goes through createPlainWindowInLock (Issue #29 review,
          // 9th pass, Important finding 1) so this branch also runs its
          // env-resolution -> create() span inside the same per-server
          // isolation lock as the primary/secondary branches, against the
          // freshly re-fetched `freshServer` row.
          const created = await createPlainWindowInLock(this.tmux, freshServer, doCreate);
          return { newName: created.windowName, windowEnv: created.env, tokenId: null as number | null, server: created.server };
        }
      });
      await sleep(createdViaNewSession ? 500 : 300);

      const baseTarget = `${sessionName}:${newName}`;
      const dbTarget = `${baseTarget}.1`;

      // Pane restoration now runs INSIDE this same lock turn, before the
      // final persist below — see the design-rationale comment above this
      // function for the orphaning bug this ordering closes.
      //
      // Everything from here through the final persist is wrapped in
      // try/catch (Issue #28 third-party review Important finding): a
      // restore/resolve/launch failure AFTER the new window was already
      // created — and, for the primary window, its task token already
      // rotated — used to propagate straight out of run(), leaving that new
      // window alive and completely untracked (the DB row still points at
      // the OLD, already-killed tmuxTarget) and, for the primary window, its
      // freshly-issued generation neither killed nor revoked. Same
      // generation-leak shape resumeLegacySession()'s own rollback closes
      // (its doc comment above), applied here via the same
      // rollbackWindowReference helper: kill the just-created window, and
      // only revoke the generation once that kill is CONFIRMED (agent
      // transports resolve, not reject, on a failed kill — see
      // resolveKillOutcome's doc comment) — a still-alive orphan instead
      // gets its dbTarget persisted so it stays discoverable, exactly like
      // resumeLegacySession's onStillAlive branch. A non-primary window has
      // no generation to protect, so it only needs the kill + discoverability
      // half (no revoke call).
      try {
        if (win.paneLayout) {
          await this.restorePaneLayout(respawnServer, baseTarget, win.paneLayout, win, supervision, resolvedCwds.paneCwds, windowEnv);
        } else {
          const paneId = await this.tmux.resolvePaneId(respawnServer, baseTarget);
          await this.setupSinglePane(respawnServer, paneId, baseTarget, win, supervision, resolvedCwds.singleCwd);
        }
      } catch (err) {
        try {
          if (isPrimary && tokenId !== null) {
            await rollbackWindowReference(
              this.tmux.killWindow(respawnServer, baseTarget),
              this.paneEnvService,
              tokenId,
              'respawn_restore_failed_rollback',
              () => {},
              () => this.windowRepo.update(windowId, { tmuxTarget: dbTarget }),
            );
          } else {
            const outcome = await resolveKillOutcome(this.tmux.killWindow(respawnServer, baseTarget));
            if (!outcome.success) {
              this.windowRepo.update(windowId, { tmuxTarget: dbTarget });
            }
          }
        } catch {}
        throw err;
      }

      this.windowRepo.update(windowId, { tmuxTarget: dbTarget, sleeping: false });

      return { tmuxTarget: dbTarget };
    };

    return task ? await runExclusiveForTask(task.id, run) : await run();
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
    // 'continuation': both `operation` values here ('respawn' and
    // 'recover_session_legacy') resume a task whose working directory a
    // past execute()/restore() already populated — neither distributes
    // anything itself.
    const { manifest, unit, projectServer } = resolveExecutionManifest(task, {
      unitRepo: this.unitRepo,
      projectRepo: this.projectRepo,
      projectServerRepo: this.projectServerRepo,
      serverRepo: this.serverRepo,
      projectSecretRepo: this.projectSecretRepo,
      unitTypeLoader: this.unitTypeLoader,
      sidekickLoader: this.sidekickLoader,
    }, 'continuation', respawnInput, server.name);
    const unitId = unit?.id ?? null;
    const manifestHash = hashExecutionManifest(manifest);
    // Issue #29 Step 3a: `server` is the caller-resolved ACTUAL target
    // server for this respawn (see the comment on this method's `server`
    // param above) — same re-check every other entry point runs, see
    // resolveEffectiveInputPolicy's doc comment.
    const effective = resolveEffectiveInputPolicy(projectServer, server, this.scopedAuthEnabled);
    if (unitId !== null && effective.allowDegradedReason) {
      appendLogAndEmit(this.logRepo, this.events, task.id, unitId, 'command', {
        type: 'execution_policy_degraded',
        requestedPolicy: effective.requestedPolicy,
        effectivePolicy: effective.effectivePolicy,
        allowDegradedReason: effective.allowDegradedReason,
      });
    }
    const gate = checkExecutionGate(task, effective.effectivePolicy, manifestHash);
    if (gate.allowed) return unitId;

    if (unitId !== null) {
      appendLogAndEmit(this.logRepo, this.events, task.id, unitId, 'command', { type: 'execution_gate_blocked', reason: gate.reason });
    }
    if (gate.reason === 'pending_approval') {
      // Atomic compare-and-swap (Issue #328 review round fix 1): this used to
      // call the generic read-then-write `taskRepo.update(...)`
      // unconditionally — the same non-atomic gap ExecuteTaskUseCase's own
      // gate had before its fix, which could overwrite an already-recorded
      // block from a concurrently-blocked entry point (e.g. an execute()
      // racing this respawn for the same untrusted task) and corrupt
      // pendingOperationPriorStatus with 'pending_approval' itself.
      // `pendingOperationWindowId` is folded into the SAME atomic write
      // (recordExecutionGateBlock's `fields.pendingOperationWindowId`) rather
      // than a separate call, so the two never observably diverge. See
      // recordExecutionGateBlock's doc comment on ITaskRepository.
      const recorded = this.taskRepo.recordExecutionGateBlock(task.id, {
        pendingOperation: operation,
        priorStatus: task.status,
        manifestHash,
        pendingOperationWindowId: windowId,
      });
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
      // Only emitted when `recorded` is true — a no-op (already-blocked)
      // attempt must not re-notify a client that already saw the first
      // block's own 'status_change'.
      if (recorded) {
        if (unitId !== null) {
          appendLogAndEmit(this.logRepo, this.events, task.id, unitId, 'status_change', { status: 'pending_approval', operation });
        }
      } else if (unitId !== null) {
        appendLogAndEmit(this.logRepo, this.events, task.id, unitId, 'command', { type: 'execution_gate_already_pending', operation });
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

    const unitId = this.enforceExecutionGate(task, server, 'recover_session_legacy', null);

    const tmuxSession = resolveTmuxSession(task.projectId, server.name, this.projectServerRepo);
    // Window generation point — rotates the task token via createRotatedWindow,
    // the same shared operation respawn()/execute()/followUp() use (Issue #28
    // third-party review finding 2): this used to call
    // paneEnvService.buildEnvForNewWindow() + tmux.createWindow() directly,
    // bypassing createRotatedWindow's rollback entirely — a createWindow that
    // resolved with a non-zero exit code (agent transport) was read as
    // success and the freshly-issued generation was never revoked. The whole
    // issue->create->launch->persist span below runs under a per-task lock
    // (design v3 §2 — see runExclusiveForTask's doc comment in
    // WindowRotation.ts) so a concurrent rotation for this task cannot
    // revoke this generation out from under it.
    const { windowName } = await runExclusiveForTask(taskId, async () => {
      const created = await createRotatedWindow(this.paneEnvService, this.serverIsolationLock, server, task, 'resume_legacy_create_failed', (freshServer, env) =>
        this.tmux.createWindow(freshServer, tmuxSession, `task-${task.id}`, { extraEnv: env }),
        true,
        // Issue #29 Step 3a review round, Important finding 1: re-verify the
        // untrusted-execution gate against `freshServer` — re-read once this
        // lock is actually acquired — before this legacy-recovery window's
        // task token/env is built, same as respawn()'s primary branch and
        // ExecuteTaskUseCase/TaskRestoreService already do. Without this, a
        // verification lapse (isolation doctor re-run, scoped auth toggled
        // off) discovered only while this call sat queued for the lock was
        // never observed — the outer enforceExecutionGate() call above ran
        // on the pre-lock snapshot and this path had no in-lock preCheck at
        // all, so a downgrade mid-wait still resumed the untrusted session
        // under the stale 'allow' decision. `respawnInput` is omitted (see
        // enforceExecutionGate's own doc comment: this operation has no
        // Window row to diverge from).
        (freshServer) => {
          // 'continuation': legacy session recovery resumes a task whose
          // working directory a past execute()/restore() already
          // populated.
          const { manifest, projectServer: freshProjectServer } = resolveExecutionManifest(task, {
            unitRepo: this.unitRepo,
            projectRepo: this.projectRepo,
            projectServerRepo: this.projectServerRepo,
            serverRepo: this.serverRepo,
            projectSecretRepo: this.projectSecretRepo,
            unitTypeLoader: this.unitTypeLoader,
            sidekickLoader: this.sidekickLoader,
          }, 'continuation', undefined, freshServer.name);
          reverifyExecutionGateInLock(
            { taskRepo: this.taskRepo, logRepo: this.logRepo, events: this.events },
            task,
            unitId,
            'recover_session_legacy',
            freshProjectServer,
            freshServer,
            this.scopedAuthEnabled,
            hashExecutionManifest(manifest),
            null,
          );
        },
      );
      // Issue #29 review (10th pass), Important finding 3: use the fresh
      // `server` row createRotatedWindow re-read and actually created the
      // window with — not the (possibly now-stale) `server` argument this
      // method was called with — for resolvePaneId/sendKeys/killWindow
      // below, same as respawn()'s other two branches already do.
      server = created.server;
      const windowTarget = `${tmuxSession}:${created.windowName}`;
      try {
        const paneId = await this.tmux.resolvePaneId(server, windowTarget);
        // --strict-mcp-config (Issue #28 design v3 §3): this is a claude worker
        // launch, same as buildClaudeLaunchCommand's, just hardcoded here instead
        // of going through it (see that function's own doc comment for why the
        // rest of its flags don't apply to a `--resume` relaunch).
        const resumeCommand = `claude --resume ${task.agentSessionId} --dangerously-skip-permissions --strict-mcp-config`;
        const isSupervised = shouldSupervise(server.type, 'agent');
        if (isSupervised) {
          this.supervisorRegistry.clearExitMarker(server.name, windowTarget);
        }
        const sendCmd = isSupervised
          ? wrapWithSupervisor(resumeCommand, {
              server,
              target: windowTarget,
              taskId: task.id,
              unitId: task.unitId ?? undefined,
              ...this.supervisorRegistry.issueLaunch({
                serverName: server.name,
                target: windowTarget,
                taskId: task.id,
                unitId: task.unitId ?? null,
              }),
            })
          : resumeCommand;
        await this.tmux.sendKeys(server, paneId, [sendCmd, 'Enter']);
      } catch (err) {
        // resolvePaneId()/sendKeys() failing after createRotatedWindow already
        // succeeded used to leave an untracked window (tmuxWindow never
        // persisted) holding a live token generation — same generation-leak
        // shape as ExecuteTaskUseCase's worktree-failure rollback branches
        // (Issue #28 third-party review finding 2). Kill the just-created
        // window via rollbackWindowReference: only revoke the generation once
        // the kill is confirmed to have actually worked, and — the second-round
        // fix — when it DIDN'T work, persist `tmuxWindow` (onStillAlive) instead
        // of leaving the just-created window with no DB reference at all; a
        // still-live pane must both keep its valid token AND stay discoverable
        // for an operator to find and clean up. The original launch error is
        // what surfaces to the caller either way. Scoped to `created.tokenId`
        // (this specific generation), not the whole task — see
        // TaskPaneEnvironmentService.revokeGeneration's doc comment.
        try {
          await rollbackWindowReference(
            this.tmux.killWindow(server, windowTarget),
            this.paneEnvService,
            created.tokenId,
            'resume_legacy_launch_failed_rollback',
            () => {},
            () => this.taskRepo.update(taskId, { tmuxWindow: created.windowName } as Partial<Task>),
          );
        } catch {}
        throw err;
      }
      this.taskRepo.update(taskId, { tmuxWindow: created.windowName } as Partial<Task>);
      return { windowName: created.windowName };
    });
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
      ...this.supervisorRegistry.issueLaunch({
        serverName: server.name,
        target: supervisorTarget,
        taskId: supervision.taskId ?? null,
        unitId: supervision.unitId ?? null,
      }),
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
    // `paneEnv` (Issue #28 review Critical finding): the SAME env the
    // window's first pane was created with (task token + rotated
    // generation, or the legacy uiTokenEnv() for a non-task window) — must
    // be passed to every splitPane() call below, since `split-window -e`
    // is the only thing that keeps an additional pane from silently
    // inheriting the tmux SESSION's own environment instead (see
    // TmuxClient.splitPane's doc comment).
    paneEnv: Record<string, string>,
  ): Promise<void> {
    const paneCount = paneLayout.panes.length;
    const firstPaneId = await this.tmux.resolvePaneId(server, baseTarget);
    for (let i = 1; i < paneCount; i++) {
      await this.tmux.splitPane(server, firstPaneId, i % 2 === 0 ? 'v' : 'h', paneEnv);
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
