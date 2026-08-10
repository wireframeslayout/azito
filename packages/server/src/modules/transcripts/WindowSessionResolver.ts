import type { Window, PaneLayout } from '../windows/Window';
import type { ITaskRepository } from '../tasks/Task';
import type { TmuxClient, TmuxPaneInfo } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import { windowSpecMatches } from '../tmux/TmuxClient';
import { stripPaneSuffix } from '../windows/paneTarget';
import type { TranscriptSource } from './sources/TranscriptSource';

// ─── Types ───

export type WindowSessionResolution =
  | { resolved: true; agentType: string; sessionId: string; paneId: string }
  | { resolved: false; reason: 'unsupported_server' | 'no_recent_session' };

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

function splitWindowTarget(tmuxTarget: string): { sessionName: string; windowSpec: string } {
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
 * ローカルサーバーのみ対応（Phase E-1 時点。SSH/agent サーバーは 'unsupported_server'）。
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
    if (!server || server.type !== 'local') {
      return { resolved: false, reason: 'unsupported_server' };
    }

    const windowPanes = await this.getWindowPanes(server, window);

    const windowLinked = this.resolveViaWindow(window);
    if (windowLinked) {
      const paneId = await this.resolvePaneId(server, window, windowPanes, windowLinked);
      if (paneId) return { resolved: true, agentType: windowLinked.agentType, sessionId: windowLinked.sessionId, paneId };
    }

    const taskLinked = this.resolveViaTask(window);
    if (taskLinked) {
      const paneId = await this.resolvePaneId(server, window, windowPanes, taskLinked);
      if (paneId) return { resolved: true, agentType: taskLinked.agentType, sessionId: taskLinked.sessionId, paneId };
    }

    const cwdMatched = this.resolveViaCwdMatch(windowPanes);
    if (cwdMatched) {
      const paneId = await this.resolvePaneId(server, window, windowPanes, cwdMatched);
      if (paneId) return { resolved: true, agentType: cwdMatched.agentType, sessionId: cwdMatched.sessionId, paneId };
    }

    return { resolved: false, reason: 'no_recent_session' };
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

  /** pane 未取得ならアクティブ pane 判定のため list-sessions を追加で1回引く（優先順位4、遅延評価）。 */
  private async resolvePaneId(
    server: ServerConfig,
    window: Window,
    windowPanes: TmuxPaneInfo[],
    resolved: { agentType: string; sessionId: string },
  ): Promise<string | null> {
    if (windowPanes.length === 0) return null;

    const metaMatch = findPaneLayoutMatch(window.paneLayout, windowPanes, resolved.sessionId, resolved.agentType);
    if (metaMatch) return metaMatch;

    if (windowPanes.some((p) => AGENT_COMMAND_EXACT.has(p.currentCommand.toLowerCase()))) {
      return selectPane(windowPanes, null, window.paneLayout, resolved.sessionId, resolved.agentType);
    }
    const activePaneIndex = await this.findActivePaneIndex(server, window);
    return selectPane(windowPanes, activePaneIndex, window.paneLayout, resolved.sessionId, resolved.agentType);
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
