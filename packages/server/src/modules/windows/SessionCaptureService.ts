import type { IWindowRepository } from './Window';
import type { ITaskRepository } from '../tasks/Task';
import type { IServerRepository } from '../servers/Server';
import type { ISessionStrategyFactory } from '../agents/SessionStrategy';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionCaptureService {
  constructor(
    private windowRepo: IWindowRepository,
    private taskRepo: ITaskRepository,
    private serverRepo: IServerRepository,
    private sessionStrategyFactory: ISessionStrategyFactory,
  ) {}

  scheduleInitialScan(winId: number, workerType: string | null, serverName: string, workingDirectory: string | null): void {
    const strategy = this.sessionStrategyFactory.create(workerType);
    if (!strategy.needsPostLaunchScan) return;
    const srv = this.serverRepo.findByName(serverName);
    if (!srv) return;

    void (async () => {
      const scanStart = new Date();
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(10_000);
        const sessionId = await strategy.scanSessionId(srv, workingDirectory, scanStart).catch(() => null);
        if (sessionId) {
          if (this.isAssigned(sessionId, serverName)) {
            strategy.excludeSessionId?.(sessionId);
            continue;
          }
          const w = this.windowRepo.findById(winId);
          if (w) this.windowRepo.updateAgentSessionIdByWindow(w.serverName, w.tmuxTarget, sessionId);
          return;
        }
      }
    })();
  }

  async tryScanForWindow(winId: number): Promise<string | null> {
    const win = this.windowRepo.findById(winId);
    if (!win || win.agentSessionId) return null;

    const strategy = this.sessionStrategyFactory.create(win.workerType);
    if (!strategy.needsPostLaunchScan) return null;

    const srv = this.serverRepo.findByName(win.serverName);
    if (!srv) return null;

    const afterTimestamp = win.createdAt ? new Date(win.createdAt + 'Z') : undefined;
    const sessionId = await strategy.scanSessionId(srv, win.workingDirectory, afterTimestamp).catch(() => null);
    if (!sessionId) return null;

    if (this.isAssigned(sessionId, win.serverName)) {
      strategy.excludeSessionId?.(sessionId);
      return null;
    }

    this.windowRepo.updateAgentSessionIdByWindow(win.serverName, win.tmuxTarget, sessionId);
    return sessionId;
  }

  /**
   * WindowSessionResolver の cwd 照合フォールバック（tier3）で解決に成功したセッションを、
   * まだ agentSessionId が未設定のウィンドウへ書き戻す（Issue #338）。既存の isAssigned ガードを
   * そのまま再利用するため、対象セッションが（自分自身を含む）どこかのウィンドウ/タスクに既に
   * 割り当て済みなら書き込まない。
   */
  adoptResolvedSession(winId: number, sessionId: string): boolean {
    const win = this.windowRepo.findById(winId);
    if (!win || win.agentSessionId) return false;
    if (this.isAssigned(sessionId, win.serverName)) return false;

    this.windowRepo.updateAgentSessionIdByWindow(win.serverName, win.tmuxTarget, sessionId);
    return true;
  }

  private isAssigned(sessionId: string, serverName: string): boolean {
    const assignedW = this.windowRepo.findAgentSessionIdsByServer(serverName);
    const assignedT = this.taskRepo.findAgentSessionIdsByServer(serverName);
    return assignedW.has(sessionId) || assignedT.has(sessionId);
  }
}
