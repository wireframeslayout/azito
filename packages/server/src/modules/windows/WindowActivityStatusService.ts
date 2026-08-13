import type { IWindowRepository, Window } from './Window';
import { isAgentWindow } from './Window';
import type { WindowSessionResolver, WindowActivityProbeResult } from '../transcripts/WindowSessionResolver';
import type { IServerRepository } from '../servers/Server';
import { stripPaneSuffix } from './paneTarget';

export interface WindowActivityStatusEntry {
  windowId: number;
  serverName: string;
  target: string;
  status: 'working' | 'idle' | 'offline';
  /**
   * このウィンドウのセッションで最終応答（transcript の terminal_final）が書かれた時刻（epoch ms、
   * 再新性の窓内のもののみ）。完了を観測できなければ null。AgentActivityMonitor の Tier 4 がこれを
   * reason='completed' 遷移の根拠に使う（P3: 「terminal_final を120秒 working に偽装して
   * working→非working 遷移を観測させる」ハックの置き換え）。
   */
  completedAt: number | null;
  /** 中断（transcript の terminal_interrupted）を観測した時刻（epoch ms）。無ければ null。 */
  interruptedAt: number | null;
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
 * 未紐付けウィンドウ（agentSessionId 無し）のセッション軽量解決を1ウィンドウあたり最低この間隔で
 * 起動する（P5）。Tier 4 のリフレッシュ（15秒）ごとに走らせると resolve() の tmux/ps 呼び出しと
 * セッション一覧の走査が常時回るため、判定周期とは切り離した低頻度に落とす。
 */
const SESSION_SCAN_INTERVAL_MS = 60_000;
/** バックオフの上限。解決できないウィンドウ（generic・セッション未作成等）を実質的に無視する速度まで落とす。 */
const SESSION_SCAN_MAX_INTERVAL_MS = 10 * 60_000;
/**
 * この回数までの連続失敗はバックオフせず {@link SESSION_SCAN_INTERVAL_MS} 間隔を維持する。
 * 「ウィンドウ登録がエージェント起動より先」という正常系（登録直後の数回は必ず失敗する）で
 * いきなり間隔が伸びると、稼働判定に載るまでが数分に伸びてしまうため。
 */
const SESSION_SCAN_GRACE_FAILURES = 3;

interface SessionScanState {
  /** 連続失敗回数（成功したらエントリごと破棄する）。 */
  failures: number;
  /** 次に走査してよい時刻（epoch ms）。 */
  nextAttemptAt: number;
  /** 走査中フラグ。同一ウィンドウの二重起動を防ぐ。 */
  inflight: boolean;
}

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
  /** 未紐付けウィンドウごとのセッション走査スケジュール（windowId → 状態）。 */
  private readonly scanState = new Map<number, SessionScanState>();

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

    // セッション未紐付けのまま「プロセスは生きている」と観測されたウィンドウ。ここに溜めて
    // compute() の最後に軽量解決を仕掛ける（scheduleSessionScans 参照）。
    const unresolvedWindows: { id: number; window: Window }[] = [];

    const perServer = await Promise.all([...byServer.entries()].map(async ([serverName, windowsOfServer]) => {
      const server = this.serverRepo.findByName(serverName);
      const snapshot = server ? await this.windowSessionResolver.captureActivityProbeSnapshot(server) : null;
      return Promise.all(windowsOfServer.map(async (w): Promise<WindowActivityStatusEntry> => {
        // Per-window isolation: one window's failure must not fail the whole
        // snapshot (a rejected Promise.all would leave the monitor's Tier 4
        // cache stale for every window on this server).
        let probe: WindowActivityProbeResult = { status: 'offline', completedAt: null, interruptedAt: null };
        if (snapshot) {
          try {
            probe = await this.windowSessionResolver.getActivityStatus(w, snapshot);
          } catch (err) {
            console.error(`[activity-status] ${serverName}:${w.tmuxTarget} failed:`, err instanceof Error ? err.message : err);
          }
        }
        // 'offline' はプロセス自体が見つからなかったケース。セッションを探しても紐付ける相手が
        // 居ないので走査しない。taskId 付きのウィンドウも除外する（タスク側 agentSessionId が
        // getActivityStatus のフォールバック元になっており、ここで別セッションを拾うと
        // 誤った紐付けを新設してしまう）。
        if (w.agentSessionId == null && w.taskId == null && probe.status !== 'offline') {
          unresolvedWindows.push({ id: w.id, window: w });
        }
        return {
          windowId: w.id,
          serverName: w.serverName,
          // Stripped, not `w.tmuxTarget` — must match AgentActivityMonitor's emitted
          // `target` (also stripped) so its Tier 4 lookup, keyed on
          // `serverName::stripPaneSuffix(target)`, resolves to the same window.
          target: stripPaneSuffix(w.tmuxTarget),
          status: probe.status,
          completedAt: probe.completedAt,
          interruptedAt: probe.interruptedAt,
          taskId: w.taskId ?? undefined,
          projectId: w.projectId ?? undefined,
          label: w.label ?? undefined,
        };
      }));
    }));
    this.scheduleSessionScans(unresolvedWindows);
    return perServer.flat();
  }

  /**
   * 未紐付けウィンドウのセッションを軽量解決する（P5）。`getActivityStatus()` は sessionId が
   * 無いウィンドウを無条件に 'idle' とするため、hook/supervisor 配線なしで手動登録された
   * ウィンドウは「他の書き戻し経路（登録時 initial scan・手動 launch・codex 稼働検知後の再 scan・
   * respawn・チャット表示時の resolve()）が全て外れた場合」に稼働判定へ載らない。
   *
   * 解決には既存の `WindowSessionResolver.resolve()` をそのまま使う。cwd 照合（tier3）で解決できた
   * ときだけ `SessionCaptureService.adoptResolvedSession()`（isAssigned ガード込み）が windows 行へ
   * 書き戻す、という既存の経路をチャット表示以外からも起動するのが本修正で、紐付けロジック自体は
   * 新設しない。`SessionCaptureService.tryScanForWindow()` ではなく resolve() を使うのは、前者が
   * `needsPostLaunchScan`（codex のみ true）と「ウィンドウ登録時刻より後に作られたセッション」に
   * 限定されており、claude ウィンドウや「エージェント起動後に登録されたウィンドウ」という
   * まさにこの穴のケースでは常に null を返すため。
   *
   * fire-and-forget で走らせる: resolve() は list-panes / ps / セッション一覧を引くため、稼働判定
   * スナップショットのレイテンシに載せない。書き戻しの結果は次回以降の compute() が windows 行から
   * 拾う。
   */
  private scheduleSessionScans(windows: { id: number; window: Window }[]): void {
    if (windows.length === 0) {
      // 未解決ウィンドウが無ければ走査もスケジュール保持も不要。
      this.scanState.clear();
      return;
    }

    const alive = new Set(windows.map((w) => w.id));
    for (const id of [...this.scanState.keys()]) {
      if (!alive.has(id)) this.scanState.delete(id);
    }

    const now = Date.now();
    for (const { id, window } of windows) {
      const state = this.scanState.get(id) ?? { failures: 0, nextAttemptAt: 0, inflight: false };
      this.scanState.set(id, state);
      if (state.inflight || now < state.nextAttemptAt) continue;

      state.inflight = true;
      void this.windowSessionResolver.resolve(window)
        .then((resolution) => {
          // 成功したらこのウィンドウはもう未解決集合に現れない（＝状態も不要）。
          if (resolution.resolved) this.scanState.delete(id);
          else this.backOff(state);
        })
        .catch((err) => {
          console.error(`[activity-status] session resolution for window ${id} failed:`, err instanceof Error ? err.message : err);
          this.backOff(state);
        });
    }
  }

  private backOff(state: SessionScanState): void {
    state.failures += 1;
    const factor = 2 ** Math.max(0, state.failures - SESSION_SCAN_GRACE_FAILURES);
    state.nextAttemptAt = Date.now() + Math.min(SESSION_SCAN_INTERVAL_MS * factor, SESSION_SCAN_MAX_INTERVAL_MS);
    state.inflight = false;
  }
}
