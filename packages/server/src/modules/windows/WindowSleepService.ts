import type { IWindowRepository, Window } from './Window';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';
import type { IServerRepository } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { muxRefFromTmuxTarget } from '@azito/shared';
import { resolveKillOutcome } from '../tmux/killOutcome';

function resolveWindowRef(win: Pick<Window, 'muxRef' | 'tmuxTarget'>) {
  return win.muxRef ?? muxRefFromTmuxTarget(win.tmuxTarget);
}

export class WindowSleepService {
  constructor(
    private windowRepo: IWindowRepository,
    private muxDriverRegistry: MuxDriverRegistry,
    private sessionStrategyFactory: ISessionStrategyFactory,
    private serverRepo: IServerRepository,
  ) {}

  canSleep(win: Window): boolean {
    return (
      win.windowType === 'agent' &&
      win.agentSessionId != null &&
      !win.sleeping &&
      this.sessionStrategyFactory.create(win.workerType).supportsSession
    );
  }

  async sleep(winId: number): Promise<void> {
    const win = this.windowRepo.findById(winId);
    if (!win) throw new Error('Window not found');
    if (!this.canSleep(win)) {
      throw new Error('Window cannot be put to sleep: requires agent window with captured session ID and session support');
    }

    const srv = this.serverRepo.findByName(win.serverName);
    if (srv) {
      const driver = this.muxDriverRegistry.resolve(srv);
      const ref = resolveWindowRef(win);
      const outcome = await resolveKillOutcome(driver.closeWindow(srv, ref));
      if (!outcome.success) {
        throw new Error(`Failed to close window before sleeping: ${outcome.result.stderr || outcome.result.stdout || 'unknown'}`);
      }
    }

    this.windowRepo.update(winId, { sleeping: true });
  }

  async sleepTaskWindows(taskId: number): Promise<number[]> {
    const windows = this.windowRepo.findByTask(taskId);
    const sleptIds: number[] = [];
    for (const win of windows) {
      if (!this.canSleep(win)) continue;
      try {
        await this.sleep(win.id);
        sleptIds.push(win.id);
      } catch {
        // individual failure should not block other windows or task completion
      }
    }
    return sleptIds;
  }
}
