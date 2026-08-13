import type { IWindowRepository } from './Window';
import { isAgentWindow } from './Window';
import type { WindowSessionResolver } from '../transcripts/WindowSessionResolver';
import type { IServerRepository } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
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
 * （複数クライアントが同時にポーリングしても実コストは 60秒に1回のみ）。ペインサフィックス統合の
 * 判定（`resolveDedupTarget`）に使う tmux 実体照会もこのキャッシュ配下にあるため、追加コストは
 * 60秒に1回、対象 local サーバーごとに `list-panes -a` 1回のみ。
 */
export class WindowActivityStatusService {
  private cache: { at: number; entries: WindowActivityStatusEntry[] } | null = null;
  private inflight: Promise<WindowActivityStatusEntry[]> | null = null;

  constructor(
    private readonly windowRepo: IWindowRepository,
    private readonly serverRepo: IServerRepository,
    private readonly windowSessionResolver: WindowSessionResolver,
    private readonly tmuxClient: TmuxClient,
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

    // Raw (un-stripped) `serverName::tmuxTarget` -> rows registered under that
    // exact target. Used by `resolveDedupTarget` below to decide, per row,
    // whether a trailing `.N` on its target is a pane suffix to strip or part
    // of the window's own name.
    const byRawTarget = new Map<string, typeof windows[number][]>();
    for (const w of windows) {
      const rawKey = `${w.serverName}::${w.tmuxTarget}`;
      const list = byRawTarget.get(rawKey);
      if (list) list.push(w); else byRawTarget.set(rawKey, [w]);
    }

    /**
     * Dedup by server+target the same way AgentActivityMonitor does (multiple DB
     * rows — project-owned and task-owned — can point at the same tmux window):
     * a project-owned row is stored without a pane suffix (e.g. `main:0`) while
     * its task-owned counterpart for the very same tmux window carries one
     * (`main:0.1`, added at window-creation time — see ExecuteTaskUseCase).
     * Left un-stripped, those key as two different windows, so both survive
     * dedup and this service emits a duplicate `WindowActivityStatusEntry` for
     * one physical window under two different `target` strings — the
     * frontend's process-based supplement merges additively (never overrides a
     * key `useAgentActivity` already has from the primary source), so the
     * un-stripped duplicate's own key is invisible to that merge and can
     * outlive the primary source's correctly-cleared entry, surfacing as a
     * stuck "running" row even after the tmux window is long gone.
     *
     * Unconditionally stripping every trailing `.N` is wrong in the other
     * direction, though: a tmux window can legitimately be *named* `agent-1.1`
     * (no relation to a pane index), and stripping it down to `agent-1` would
     * misidentify it as a duplicate of an unrelated window actually named
     * `agent-1` — dropping one of two genuinely independent status rows and
     * reporting the wrong `target` for the survivor.
     *
     * Decided by a live tmux entity query (`tmuxWindowNamesByServer`, populated
     * once per local serverName below — this service is already behind a
     * 60-second cache, so the cost is acceptable): a trailing `.N` target is
     * treated as a pane suffix (merge/strip) only when the raw target does NOT
     * exist as an actual tmux window name in that session while the stripped
     * form DOES; it is left as an independent window (no strip) when the raw
     * target itself exists as a real window name. When the tmux query for that
     * server failed (or the window doesn't currently exist under either form —
     * e.g. it already closed), this falls back to the previous ownership
     * heuristic: the suffix is treated as a pane suffix only when BOTH:
     *   1. another row exists under the exact stripped form as its raw target
     *      (i.e. a plausible "same window" sibling), AND
     *   2. that sibling's ownership is complementary — one row is task-owned
     *      (`taskId != null`) and the other is project-owned (`taskId ==
     *      null`) — which is the one production shape this duplication
     *      actually comes from (a task run's window also gets a project-scoped
     *      row, or vice versa; migration 028's "deduplicate project windows"
     *      and ExecuteTaskUseCase's window registration are the two writers).
     * Two independently-registered rows that happen to share this naming
     * pattern but are NOT complementary-owned (e.g. both project-owned, for
     * two different projects) are left un-merged, even though they might
     * occasionally still be the same physical window by coincidence — that
     * false-negative (reporting one extra row) is preferred over the
     * false-positive of silently dropping a genuinely independent window's
     * status.
     */
    const tmuxWindowNamesByServer = await this.fetchTmuxWindowNamesByServer(windows);

    const resolveDedupTarget = (w: typeof windows[number]): string => {
      const stripped = stripPaneSuffix(w.tmuxTarget);
      if (stripped === w.tmuxTarget) return w.tmuxTarget; // no trailing `.N` at all

      const tmuxNames = tmuxWindowNamesByServer.get(w.serverName);
      if (tmuxNames) {
        if (tmuxNames.has(w.tmuxTarget)) return w.tmuxTarget; // raw target exists as a real window name — independent window, don't merge
        if (tmuxNames.has(stripped)) return stripped; // raw absent, stripped form exists — confirmed pane suffix, merge
        // Neither form is currently alive in tmux (e.g. window already closed) — fall through to the heuristic below.
      }

      const siblings = byRawTarget.get(`${w.serverName}::${stripped}`);
      if (!siblings) return w.tmuxTarget; // no row registered under the stripped form — likely just this window's own name
      const hasComplementaryOwner = siblings.some((s) => (s.taskId != null) !== (w.taskId != null));
      return hasComplementaryOwner ? stripped : w.tmuxTarget;
    };

    const byKey = new Map<string, { window: typeof windows[number]; target: string }>();
    for (const w of windows) {
      const target = resolveDedupTarget(w);
      const key = `${w.serverName}::${target}`;
      const existing = byKey.get(key);
      if (!existing || (w.taskId != null && existing.window.taskId == null)) byKey.set(key, { window: w, target });
    }

    const localEntries = [...byKey.values()].filter(({ window: w }) => this.serverRepo.findByName(w.serverName)?.type === 'local');

    const entries = await Promise.all(localEntries.map(async ({ window: w, target }): Promise<WindowActivityStatusEntry> => {
      const status = await this.windowSessionResolver.getActivityStatus(w);
      return {
        windowId: w.id,
        serverName: w.serverName,
        // The dedup-resolved target, not raw `w.tmuxTarget`: stripped when a
        // complementary-owned sibling justified treating it as a pane suffix
        // (matches AgentActivityMonitor's own stripped `target`), left as-is
        // otherwise (a standalone `.N`-named window keeps its real name).
        target,
        status,
        taskId: w.taskId ?? undefined,
        projectId: w.projectId ?? undefined,
        label: w.label ?? undefined,
      };
    }));
    return entries;
  }

  /**
   * `resolveDedupTarget` の tmux 実体照会レイヤー。`.N` サフィックス付き target を持つ行の
   * serverName だけを対象に、対象サーバーが local 型であれば `list-panes -a` を1回だけ実行し、
   * そのセッション内に実在する `sessionName:windowName`（生の window 名。ペインサフィックスは
   * 含まない）の集合を返す。呼び出し元はこの集合に対して raw target / stripped target をそのまま
   * 照会するだけで、両者を区別できる。
   *
   * 対象外（`.N` を持つ行が無いサーバー、local でないサーバー）は照会自体を行わない。クエリが失敗
   * した場合（`listAllPanes` が例外を投げた場合。実装上は空配列を返して吸収するため通常は起きない
   * が、念のため）はそのサーバーを Map から欠落させ、呼び出し元が既存の所有形態ヒューリスティックへ
   * フォールバックできるようにする。
   */
  private async fetchTmuxWindowNamesByServer(
    windows: ReturnType<IWindowRepository['findAll']>,
  ): Promise<Map<string, Set<string>>> {
    const suffixedServerNames = new Set(
      windows
        .filter((w) => stripPaneSuffix(w.tmuxTarget) !== w.tmuxTarget && this.serverRepo.findByName(w.serverName)?.type === 'local')
        .map((w) => w.serverName),
    );

    const result = new Map<string, Set<string>>();
    await Promise.all([...suffixedServerNames].map(async (serverName) => {
      const server = this.serverRepo.findByName(serverName);
      if (!server) return; // resolved between the filter above and here — treat as query failure (fallback)
      try {
        const panes = await this.tmuxClient.listAllPanes(server);
        result.set(serverName, new Set(panes.map((p) => `${p.sessionName}:${p.windowName}`)));
      } catch {
        // Leave this serverName absent from the map — resolveDedupTarget falls back to the
        // ownership heuristic when a server's tmux query is missing.
      }
    }));
    return result;
  }
}
