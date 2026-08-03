import type { IWindowRepository, PaneLayout, Window } from './Window';
import type { ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { ITaskRepository } from '../tasks/Task';
import type { IUnitRepository } from '../units/Unit';
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
  constructor(
    private windowRepo: IWindowRepository,
    private tmux: TmuxClient,
    private sessionStrategyFactory: ISessionStrategyFactory,
    private taskRepo: ITaskRepository,
    private unitRepo: IUnitRepository,
    private supervisorRegistry: SupervisorRegistry,
    private sessionCaptureService?: SessionCaptureService,
  ) {}

  async respawn(windowId: number, server: ServerConfig): Promise<{ tmuxTarget: string }> {
    const win = this.windowRepo.findById(windowId);
    if (!win) throw new Error('Window not found');

    const parts = win.tmuxTarget.split(':');
    const sessionName = parts[0];
    const windowPart = parts[1]?.split('.')[0];
    if (!windowPart) throw new Error(`Invalid tmuxTarget: ${win.tmuxTarget}`);

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
      await this.restorePaneLayout(server, baseTarget, win.paneLayout, win, supervision);
    } else {
      const paneId = await this.tmux.resolvePaneId(server, baseTarget);
      await this.setupSinglePane(server, paneId, baseTarget, win, supervision);
    }

    return { tmuxTarget: dbTarget };
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
      const cwd = pane.workingDirectory || win.workingDirectory;
      if (cwd) {
        await this.tmux.sendKeys(server, paneId, [`cd ${cwd}`, 'Enter']);
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
  ): Promise<void> {
    if (win.workingDirectory) {
      await this.tmux.sendKeys(server, paneId, [`cd ${win.workingDirectory}`, 'Enter']);
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
