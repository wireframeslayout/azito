import type { IWindowRepository } from './Window';
import { isAgentWindow } from './Window';
import type { WindowSessionResolver } from '../transcripts/WindowSessionResolver';
import type { IServerRepository } from '../servers/Server';
import { stripPaneSuffix } from './paneTarget';

export interface WindowActivityStatusEntry {
  windowId: number;
  serverName: string;
  target: string;
  status: 'working' | 'idle' | 'offline';
  taskId?: number;
  projectId?: number;
  label?: string;
}

const CACHE_TTL_MS = 60_000;

/**
 * プロセス実体検査ベースの軽量な稼働判定 API（Issue #338 フォロー、AZITO監視強化）を提供する。
 * `AgentActivityMonitor`（hook/tui-supervisor 接続を前提に notification イベントを配信する既存の
 * 監視）とは完全に独立した並行パスとして追加した — 既存モニタの挙動（通知・ブロック検出等）は
 * 一切変更しない。hook/supervisor の配線が無い（手動起動の）エージェントウィンドウでも、実プロセスの
 * 存在とセッションファイルの活動シグナルから「稼働中/待機中/オフライン」を判定できるようにするため、
 * `WindowSessionResolver.getActivityStatus()`（resolve() のレイヤー2/3 判定を流用）を全 local
 * エージェントウィンドウに対して呼び出す。
 *
 * ps/tmux 呼び出しをリクエストのたびに行わないよう、60秒 TTL のプロセス内キャッシュを持つ
 * （複数クライアントが同時にポーリングしても実コストは 60秒に1回のみ）。
 */
export class WindowActivityStatusService {
  private cache: { at: number; entries: WindowActivityStatusEntry[] } | null = null;
  private inflight: Promise<WindowActivityStatusEntry[]> | null = null;

  constructor(
    private readonly windowRepo: IWindowRepository,
    private readonly serverRepo: IServerRepository,
    private readonly windowSessionResolver: WindowSessionResolver,
  ) {}

  async list(): Promise<WindowActivityStatusEntry[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.entries;
    if (this.inflight) return this.inflight;

    this.inflight = this.compute().then((entries) => {
      this.cache = { at: Date.now(), entries };
      this.inflight = null;
      return entries;
    }).catch((err) => {
      this.inflight = null;
      throw err;
    });
    return this.inflight;
  }

  private async compute(): Promise<WindowActivityStatusEntry[]> {
    const windows = this.windowRepo.findAll().filter(isAgentWindow);

    // Dedup by server+target the same way AgentActivityMonitor does (multiple DB
    // rows — project-owned and task-owned — can point at the same tmux window).
    // The key MUST strip the pane suffix (`stripPaneSuffix`, mirroring
    // AgentActivityMonitor's own `windowKey()`): a project-owned row is stored
    // without a pane suffix (e.g. `main:0`) while its task-owned counterpart for
    // the very same tmux window carries one (`main:0.1`, added at window-creation
    // time — see ExecuteTaskUseCase). Keying on the raw `tmuxTarget` treats those
    // as two different windows, so both survive the dedup and this service emits
    // a duplicate `WindowActivityStatusEntry` for one physical window under two
    // different `target` strings. The frontend's process-based supplement merges
    // additively (never overrides a key `useAgentActivity` already has from the
    // primary source), so the un-stripped duplicate's own key is invisible to
    // that merge and can outlive the primary source's correctly-cleared entry —
    // surfacing as a stuck "running" row even after the tmux window is long gone.
    const byKey = new Map<string, typeof windows[number]>();
    for (const w of windows) {
      const key = `${w.serverName}::${stripPaneSuffix(w.tmuxTarget)}`;
      const existing = byKey.get(key);
      if (!existing || (w.taskId != null && existing.taskId == null)) byKey.set(key, w);
    }

    const localWindows = [...byKey.values()].filter((w) => this.serverRepo.findByName(w.serverName)?.type === 'local');

    const entries = await Promise.all(localWindows.map(async (w): Promise<WindowActivityStatusEntry> => {
      const status = await this.windowSessionResolver.getActivityStatus(w);
      return {
        windowId: w.id,
        serverName: w.serverName,
        // Stripped, not `w.tmuxTarget` — must match AgentActivityMonitor's emitted
        // `target` (also stripped) so a client keying entries by `serverName::target`
        // (see useAgentActivity's processStatusKey) treats them as the same window.
        target: stripPaneSuffix(w.tmuxTarget),
        status,
        taskId: w.taskId ?? undefined,
        projectId: w.projectId ?? undefined,
        label: w.label ?? undefined,
      };
    }));
    return entries;
  }
}
