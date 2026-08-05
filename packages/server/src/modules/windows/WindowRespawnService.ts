import type { IWindowRepository, PaneLayout, Window } from './Window';
import type { ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { ITaskRepository } from '../tasks/Task';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { PathResolverFactory, assertDirectoryContained } from '../git/PathContainment';
import { shellQuote } from '../../shared/shellQuote';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import { shouldSupervise, wrapWithSupervisor } from '../supervisors/SupervisorLaunch';
import type { SessionCaptureService } from './SessionCaptureService';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    private transportFactory: TransportFactory,
    private sessionCaptureService?: SessionCaptureService,
  ) {}

  async respawn(windowId: number, server: ServerConfig): Promise<{ tmuxTarget: string }> {
    const win = this.windowRepo.findById(windowId);
    if (!win) throw new Error('Window not found');

    const parts = win.tmuxTarget.split(':');
    const sessionName = parts[0];
    const windowPart = parts[1]?.split('.')[0];
    if (!windowPart) throw new Error(`Invalid tmuxTarget: ${win.tmuxTarget}`);

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
    let unitId: number | null = null;
    if (win.taskId !== null) {
      const task = this.taskRepo.findById(win.taskId);
      if (task && task.unitId !== null) {
        const unit = this.unitRepo.findById(task.unitId);
        if (unit) unitId = unit.id;
      }
    }
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
   * Resolves the project's configured working directory (the containment
   * boundary — see PathContainment.ts) for the window being respawned, or
   * `null` when it can't be determined. `null` means "no boundary to
   * enforce" and the caller must skip verification, same as
   * ExecuteTaskUseCase/TaskRestoreService do when a project has no
   * projectServer.workingDirectory configured — this must never be treated
   * as "verification failed" (Issue #27 review finding 1).
   */
  private resolveAllowedRoot(win: Window, serverName: string): string | null {
    if (!this.projectServerRepo) return null;
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
   * `allowedRoot` or `transportFactory` is unavailable.
   */
  private async resolveContainedCwd(server: ServerConfig, cwd: string, allowedRoot: string | null, label: string): Promise<string> {
    if (!allowedRoot || !this.transportFactory) return cwd;
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
