import type { Window, PaneLayout } from '../windows/Window';
import type { ITaskRepository } from '../tasks/Task';
import type { TmuxClient, TmuxPaneInfo } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import { windowSpecMatches } from '../tmux/TmuxClient';
import { stripPaneSuffix } from '../windows/paneTarget';
import type { TranscriptSource } from './sources/TranscriptSource';

// ─── Types ───

export type WindowSessionResolution =
  | { resolved: true; agentType: string; sessionId: string; paneId: string; agentDetected: boolean }
  | {
      resolved: false;
      reason: 'unsupported_server' | 'no_recent_session';
      /** best-effort な pane 解決結果（セッション未解決でもウィンドウ直接入力のために提供する。Issue #69 仕様調整3）。 */
      paneId?: string;
      agentType?: string;
      agentDetected: boolean;
    };

// ─── Constants ───

/** 直近この時間以内に更新されたセッションのみ「動作中」とみなす（cwd 照合フォールバック、優先順位3）。 */
const RECENT_SESSION_WINDOW_MS = 30 * 60 * 1000;
/** pane_current_command がこれに一致すれば「エージェントが動いていそうな pane」として優先する（node 系フォールバック、下記 selectPane 参照）。 */
const AGENT_COMMAND_PATTERN = /^(node|claude|codex)/i;
/** ソースとして自動解決に対応する workerType（= TranscriptSource.agentType と一致するもの）。generic 等は非対応。 */
const SUPPORTED_WORKER_TYPES = new Set(['claude', 'codex']);
/** pane_current_command がこれと完全一致すれば最優先でエージェント pane とみなす。 */
const AGENT_COMMAND_EXACT = new Set(['claude', 'codex']);

// ─── Helpers ───

export function splitWindowTarget(tmuxTarget: string): { sessionName: string; windowSpec: string } {
  const stripped = stripPaneSuffix(tmuxTarget);
  const colonIndex = stripped.indexOf(':');
  if (colonIndex === -1) return { sessionName: stripped, windowSpec: '' };
  return { sessionName: stripped.slice(0, colonIndex), windowSpec: stripped.slice(colonIndex + 1) };
}

/**
 * window.paneLayout に、解決済みセッション（sessionId優先、なければ workerType）に対応するメタがあれば
 * そのペインを返す（優先順位・最優先）。paneLayout はウィンドウ作成時に確定したペイン構成のメタデータで、
 * pane_current_command のようなランタイム状態のブレに影響されない。
 */
function findPaneLayoutMatch(
  paneLayout: PaneLayout | null,
  windowPanes: TmuxPaneInfo[],
  resolvedSessionId: string,
  resolvedAgentType: string,
): string | null {
  if (!paneLayout) return null;

  const bySessionId = paneLayout.panes.find((p) => p.agentSessionId === resolvedSessionId);
  const metaPane = bySessionId ?? paneLayout.panes.find((p) => p.workerType === resolvedAgentType);
  if (!metaPane) return null;

  const match = windowPanes.find((p) => p.paneIndex === metaPane.index);
  return match?.paneId ?? null;
}

/** 「エージェントが動いていそうな pane」を選ぶ。paneLayout メタ → command 完全一致 → アクティブ pane → node 系 → 先頭 pane の順。 */
function selectPane(
  panes: TmuxPaneInfo[],
  activePaneIndex: number | null,
  paneLayout: PaneLayout | null,
  resolvedSessionId: string,
  resolvedAgentType: string,
): string | null {
  const metaMatch = findPaneLayoutMatch(paneLayout, panes, resolvedSessionId, resolvedAgentType);
  if (metaMatch) return metaMatch;

  const exactMatch = panes.find((p) => AGENT_COMMAND_EXACT.has(p.currentCommand.toLowerCase()));
  if (exactMatch) return exactMatch.paneId;

  if (activePaneIndex !== null) {
    const active = panes.find((p) => p.paneIndex === activePaneIndex);
    if (active) return active.paneId;
  }

  const nodeMatch = panes.find((p) => AGENT_COMMAND_PATTERN.test(p.currentCommand));
  if (nodeMatch) return nodeMatch.paneId;

  return panes[0]?.paneId ?? null;
}

// ─── Service ───

/**
 * windows テーブルの1行から「そのウィンドウで動いているエージェントの会話セッション」を自動解決する
 * サービス（Issue #69 Phase E-1）。手動のセッション選択（TranscriptPaneService.listPaneCandidates に
 * よるユーザー選択）の前段として、優先順位つきで自動判定を試みる:
 *
 * 1. ウィンドウ自身のセッション: window.agentSessionId があれば、window.workerType に対応するソース
 *    （claude/codex。generic 等未対応 workerType は次の優先順位へ）で実在確認して採用する。プロジェクト
 *    直属ウィンドウ（taskId が null）もここで解決できる。
 * 2. タスク連携: window.taskId に紐づく task の agent_session_id を採用する。ソース選択は window.workerType
 *    に従い（claude/codex ならそれ固定）、workerType が不明/未対応な場合は全ソースを実在確認で総当たりする。
 * 3. cwd 照合フォールバック: このウィンドウの pane の cwd と、全 TranscriptSource のセッション一覧の cwd を
 *    突合し、直近 30 分以内に更新された最新セッションを採用（claude/codex 横断）。
 * 4. pane 選定: 上記いずれかで解決したセッションに対し、window.paneLayout にそのセッション/workerType の
 *    メタがあれば最優先で採用し、無ければ pane_current_command が claude/codex に完全一致する pane、
 *    無ければアクティブ pane、それも無ければ node 系 pane、最後に先頭 pane を返す。
 *
 * セッション自動解決自体はローカルサーバーのみ対応（Phase E-1 時点。SSH/agent サーバーは
 * 'unsupported_server'）。ただし pane 解決（優先順位4のロジック）自体は tmux コマンドの
 * トランスポート抽象化により全サーバー種別で動作するため、セッションが解決できない場合でも
 * best-effort で paneId・window.workerType 由来の agentType を返す（Issue #69 仕様調整3。
 * ウィンドウ直接入力 API がセッション JSONL 未作成でもチャットを開始できるようにするため）。
 * server 自体が見つからない場合（window.serverName が指す ServerConfig が存在しない）は
 * tmux コマンドを打つ先すら無いため best-effort もできない。
 */
export class WindowSessionResolver {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly tmuxClient: TmuxClient,
    private readonly serverRepo: IServerRepository,
    private readonly sources: TranscriptSource[],
  ) {}

  async resolve(window: Window): Promise<WindowSessionResolution> {
    const server = this.serverRepo.findByName(window.serverName);
    if (!server) {
      return { resolved: false, reason: 'unsupported_server', agentDetected: false };
    }

    const windowPanes = await this.getWindowPanes(server, window);
    const isLocal = server.type === 'local';

    if (isLocal) {
      const windowLinked = this.resolveViaWindow(window);
      if (windowLinked) {
        const pane = await this.resolvePaneWithDetection(server, window, windowPanes, windowLinked.sessionId, windowLinked.agentType);
        if (pane) return { resolved: true, agentType: windowLinked.agentType, sessionId: windowLinked.sessionId, ...pane };
      }

      const taskLinked = this.resolveViaTask(window);
      if (taskLinked) {
        const pane = await this.resolvePaneWithDetection(server, window, windowPanes, taskLinked.sessionId, taskLinked.agentType);
        if (pane) return { resolved: true, agentType: taskLinked.agentType, sessionId: taskLinked.sessionId, ...pane };
      }

      const cwdMatched = this.resolveViaCwdMatch(windowPanes);
      if (cwdMatched) {
        const pane = await this.resolvePaneWithDetection(server, window, windowPanes, cwdMatched.sessionId, cwdMatched.agentType);
        if (pane) return { resolved: true, agentType: cwdMatched.agentType, sessionId: cwdMatched.sessionId, ...pane };
      }
    }

    const reason: 'unsupported_server' | 'no_recent_session' = isLocal ? 'no_recent_session' : 'unsupported_server';
    const fallback = await this.resolvePaneWithDetection(server, window, windowPanes, '', window.workerType ?? '');
    if (!fallback) return { resolved: false, reason, agentDetected: false };
    return { resolved: false, reason, paneId: fallback.paneId, agentType: window.workerType ?? undefined, agentDetected: fallback.agentDetected };
  }

  /** 優先順位1: ウィンドウ自身のセッション。session が存在しなければ null（呼び出し元がフォールバックする）。 */
  private resolveViaWindow(window: Window): { agentType: string; sessionId: string } | null {
    if (!window.agentSessionId) return null;
    return this.resolveSessionForId(window.agentSessionId, window.workerType);
  }

  /** 優先順位2: タスク連携。session が存在しなければ null（呼び出し元がフォールバックする）。 */
  private resolveViaTask(window: Window): { agentType: string; sessionId: string } | null {
    if (window.taskId === null) return null;
    const task = this.taskRepo.findById(window.taskId);
    if (!task || !task.agentSessionId) return null;
    return this.resolveSessionForId(task.agentSessionId, window.workerType);
  }

  /**
   * sessionId が実在するソースを、workerType（対応: claude/codex）で選ぶ。workerType が未対応/不明な
   * 場合は全ソースを実在確認で総当たりする。
   */
  private resolveSessionForId(sessionId: string, workerType: string | null): { agentType: string; sessionId: string } | null {
    if (workerType !== null && SUPPORTED_WORKER_TYPES.has(workerType)) {
      const source = this.sources.find((s) => s.agentType === workerType);
      if (!source) return null;
      const meta = source.getSessionCwd(sessionId);
      if (!meta) return null; // セッションファイルが実在しない（不正な session id を含む）
      return { agentType: workerType, sessionId };
    }

    for (const source of this.sources) {
      const meta = source.getSessionCwd(sessionId);
      if (meta) return { agentType: source.agentType, sessionId };
    }
    return null;
  }

  /** 優先順位3: cwd 照合フォールバック。複数一致時は mtime 最新を採用。 */
  private resolveViaCwdMatch(windowPanes: TmuxPaneInfo[]): { agentType: string; sessionId: string } | null {
    const windowCwds = new Set(windowPanes.map((p) => p.currentPath).filter((cwd) => cwd.length > 0));
    if (windowCwds.size === 0) return null;

    const candidates = this.sources
      .flatMap((source) => source.listSessions())
      .filter((session) => session.cwd !== null && windowCwds.has(session.cwd));
    if (candidates.length === 0) return null;

    const latest = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    if (Date.now() - latest.mtimeMs > RECENT_SESSION_WINDOW_MS) return null;

    return { agentType: latest.agentType, sessionId: latest.sessionId };
  }

  private async getWindowPanes(server: ServerConfig, window: Window): Promise<TmuxPaneInfo[]> {
    const { sessionName, windowSpec } = splitWindowTarget(window.tmuxTarget);
    const allPanes = await this.tmuxClient.listAllPanes(server);
    return allPanes.filter((p) => p.sessionName === sessionName && windowSpecMatches(windowSpec, p.windowIndex, p.windowName));
  }

  /**
   * pane 選定（優先順位4）＋ agentDetected 判定を一度に行う。sessionId/agentType は解決済みセッションが
   * あれば渡す。best-effort 呼び出し時（セッション未解決）は sessionId='' / agentType=window.workerType ?? ''
   * を渡す — paneLayout メタは sessionId 空文字ではマッチせず、workerType 一致のみで判定される。
   * pane 未取得ならアクティブ pane 判定のため list-sessions を追加で1回引く（遅延評価）。
   * agentDetected は「paneLayout メタで明示的にこの pane がエージェント用と分かっている」または
   * 「pane_current_command が claude/codex に完全一致」のいずれかで true。
   */
  private async resolvePaneWithDetection(
    server: ServerConfig,
    window: Window,
    windowPanes: TmuxPaneInfo[],
    sessionId: string,
    agentType: string,
  ): Promise<{ paneId: string; agentDetected: boolean } | null> {
    if (windowPanes.length === 0) return null;

    // pane 選択には paneLayout メタを引き続き使う（Important #3 修正前と同じ優先順位）。ただし
    // agentDetected はここでは決定しない — メタは「作成時点でエージェント用と確定していた」ことしか
    // 示さず、その後エージェントが落ちて bash に戻った pane でも一致し続けるため、警告を誤って
    // 抑制してしまう。agentDetected は選択後に live な currentCommand から判定し直す。
    const metaMatch = findPaneLayoutMatch(window.paneLayout, windowPanes, sessionId, agentType);

    let paneId: string | null;
    if (metaMatch) {
      paneId = metaMatch;
    } else if (windowPanes.some((p) => AGENT_COMMAND_EXACT.has(p.currentCommand.toLowerCase()))) {
      paneId = selectPane(windowPanes, null, window.paneLayout, sessionId, agentType);
    } else {
      const activePaneIndex = await this.findActivePaneIndex(server, window);
      paneId = selectPane(windowPanes, activePaneIndex, window.paneLayout, sessionId, agentType);
    }
    if (!paneId) return null;

    const pane = windowPanes.find((p) => p.paneId === paneId);
    const agentDetected = pane !== undefined && AGENT_COMMAND_EXACT.has(pane.currentCommand.toLowerCase());
    return { paneId, agentDetected };
  }

  private async findActivePaneIndex(server: ServerConfig, window: Window): Promise<number | null> {
    const { sessionName, windowSpec } = splitWindowTarget(window.tmuxTarget);
    const sessions = await this.tmuxClient.listSessions(server);
    const session = sessions.find((s) => s.name === sessionName);
    if (!session) return null;
    const win = session.windows.find((w) => windowSpecMatches(windowSpec, w.index, w.name));
    if (!win) return null;
    return win.panes.find((p) => p.active)?.index ?? null;
  }
}
