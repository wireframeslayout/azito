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

/**
 * TTL of the in-process snapshot cache. Kept below AgentActivityMonitor's own
 * Tier 4 refresh interval (PROCESS_PROBE_REFRESH_MS = 15s) so that refresh
 * always recomputes: a TTL at or above the refresh interval reintroduces the
 * phase problem the old 60s cache × 60s client poll had, where a state change
 * could take up to two full periods to become visible.
 */
const CACHE_TTL_MS = 10_000;

/**
 * プロセス実体検査ベースの軽量な稼働判定。hook/supervisor の配線が無い（手動起動の）エージェント
 * ウィンドウでも、実プロセスの存在とセッションファイルの活動シグナルから「稼働中/待機中/オフライン」
 * を判定するため、`WindowSessionResolver.getActivityStatus()`（resolve() のレイヤー2/3 判定を流用）
 * を全 local エージェントウィンドウに対して呼び出す。
 *
 * このサービスは `AgentActivityMonitor` の **Tier 4**（最下位ソース、`ProcessActivityProbe` として
 * 注入）である。以前はフロントが本 API を直接ポーリングして主系スナップショットへ加算マージする
 * 並行経路だったが、それは「上位 Tier が idle と判定したキーを下位のプロセス判定が再点灯させる」
 * 構造的欠陥を持っていたため撤去した。優先順位の調停はサーバー側の単一ラダー
 * （AgentActivityMonitor.collect()）に一本化されており、本クラスは判定素材だけを返す。
 *
 * `GET /api/windows/activity-status` は同じスナップショットを診断用に公開したままにしてある
 * （UI からは参照されない）。ps/tmux 呼び出しをリクエストのたびに行わないよう短い TTL の
 * プロセス内キャッシュを持ち、モニタの定期リフレッシュと HTTP 診断アクセスが同じキャッシュに乗る。
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
    //
    // Known limitation (deliberate): the strip is unconditional, so a window
    // whose *own name* ends in `.N` — only reachable by importing an external
    // tmux session, since AZITO-generated names are `win--xxxx`
    // (see windowNameUtils.ts) — is keyed as if that suffix were a pane index
    // and can collide with an unrelated window actually named without it.
    // A conditional strip (live tmux entity lookup + ownership heuristic) was
    // tried and removed: the downstream consumer of this `target`,
    // `WindowSessionResolver.splitWindowTarget()`, strips unconditionally
    // anyway, so preserving the raw form here bought no protection while
    // costing a per-poll `list-panes -a` and three layers of branching.
    // The real fix is to canonicalize activity identity on tmux's own
    // `#{window_id}` across every layer (windows table, hook script,
    // supervisor register, frontend tab ids) — tracked separately; do that
    // rather than re-adding a conditional strip here.
    const byKey = new Map<string, typeof windows[number]>();
    for (const w of windows) {
      const key = `${w.serverName}::${stripPaneSuffix(w.tmuxTarget)}`;
      const existing = byKey.get(key);
      if (!existing || (w.taskId != null && existing.taskId == null)) byKey.set(key, w);
    }

    const localWindows = [...byKey.values()].filter((w) => this.serverRepo.findByName(w.serverName)?.type === 'local');
    if (localWindows.length === 0) return [];

    // Group by server so the expensive part (`list-panes -a` + `ps`) runs once
    // per server instead of once per window: this snapshot is shared by every
    // window's classification below (see captureActivityProbeSnapshot). A
    // server whose snapshot cannot be taken (tmux/ps failure) yields 'offline'
    // for its windows — process existence is exactly what could not be
    // confirmed.
    const byServer = new Map<string, typeof localWindows>();
    for (const w of localWindows) {
      const list = byServer.get(w.serverName);
      if (list) list.push(w);
      else byServer.set(w.serverName, [w]);
    }

    const perServer = await Promise.all([...byServer.entries()].map(async ([serverName, windowsOfServer]) => {
      const server = this.serverRepo.findByName(serverName);
      const snapshot = server ? await this.windowSessionResolver.captureActivityProbeSnapshot(server) : null;
      return Promise.all(windowsOfServer.map(async (w): Promise<WindowActivityStatusEntry> => {
        // Per-window isolation: one window's failure must not fail the whole
        // snapshot (a rejected Promise.all would leave the monitor's Tier 4
        // cache stale for every window on this server).
        let status: 'working' | 'idle' | 'offline' = 'offline';
        if (snapshot) {
          try {
            status = await this.windowSessionResolver.getActivityStatus(w, snapshot);
          } catch (err) {
            console.error(`[activity-status] ${serverName}:${w.tmuxTarget} failed:`, err instanceof Error ? err.message : err);
          }
        }
        return {
          windowId: w.id,
          serverName: w.serverName,
          // Stripped, not `w.tmuxTarget` — must match AgentActivityMonitor's emitted
          // `target` (also stripped) so its Tier 4 lookup, keyed on
          // `serverName::stripPaneSuffix(target)`, resolves to the same window.
          target: stripPaneSuffix(w.tmuxTarget),
          status,
          taskId: w.taskId ?? undefined,
          projectId: w.projectId ?? undefined,
          label: w.label ?? undefined,
        };
      }));
    }));
    return perServer.flat();
  }
}
