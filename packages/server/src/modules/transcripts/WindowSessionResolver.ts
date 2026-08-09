import type { Window } from '../windows/Window';
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

/** 直近この時間以内に更新されたセッションのみ「動作中」とみなす（cwd 照合フォールバック、優先順位2）。 */
const RECENT_SESSION_WINDOW_MS = 30 * 60 * 1000;
/** pane_current_command がこれに一致すれば「エージェントが動いていそうな pane」として優先する（優先順位3）。 */
const AGENT_COMMAND_PATTERN = /^(node|claude|codex)/i;
/** タスク連携（優先順位1）で採用するセッションの種別。agent_session_id は claude --resume 専用（AGENTS.md 参照）。 */
const TASK_LINKED_AGENT_TYPE = 'claude';

// ─── Helpers ───

function splitWindowTarget(tmuxTarget: string): { sessionName: string; windowSpec: string } {
  const stripped = stripPaneSuffix(tmuxTarget);
  const colonIndex = stripped.indexOf(':');
  if (colonIndex === -1) return { sessionName: stripped, windowSpec: '' };
  return { sessionName: stripped.slice(0, colonIndex), windowSpec: stripped.slice(colonIndex + 1) };
}

/** 「エージェントが動いていそうな pane」を選ぶ。command 一致 → アクティブ pane → 先頭 pane の順。 */
function selectPane(panes: TmuxPaneInfo[], activePaneIndex: number | null): string | null {
  const agentPane = panes.find((p) => AGENT_COMMAND_PATTERN.test(p.currentCommand));
  if (agentPane) return agentPane.paneId;

  if (activePaneIndex !== null) {
    const active = panes.find((p) => p.paneIndex === activePaneIndex);
    if (active) return active.paneId;
  }

  return panes[0]?.paneId ?? null;
}

// ─── Service ───

/**
 * windows テーブルの1行から「そのウィンドウで動いているエージェントの会話セッション」を自動解決する
 * サービス（Issue #69 Phase E-1）。手動のセッション選択（TranscriptPaneService.listPaneCandidates に
 * よるユーザー選択）の前段として、優先順位つきで自動判定を試みる:
 *
 * 1. タスク連携: window.taskId に紐づく task の agent_session_id をそのまま採用（claude --resume 専用のため
 *    claude ソース固定）。セッションファイルが実在しなければ次へフォールバック。
 * 2. cwd 照合フォールバック: このウィンドウの pane の cwd と、全 TranscriptSource のセッション一覧の cwd を
 *    突合し、直近 30 分以内に更新された最新セッションを採用（claude/codex 横断）。
 * 3. pane 選定: 上記いずれかで解決したセッションに対し、pane_current_command が node/claude/codex 系の
 *    pane を優先し、無ければアクティブ pane、それも無ければ先頭 pane を返す。
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

    const taskLinked = await this.resolveViaTask(window);
    if (taskLinked) {
      const paneId = await this.resolvePaneId(server, window, windowPanes);
      if (paneId) return { resolved: true, agentType: taskLinked.agentType, sessionId: taskLinked.sessionId, paneId };
    }

    const cwdMatched = this.resolveViaCwdMatch(windowPanes);
    if (cwdMatched) {
      const paneId = await this.resolvePaneId(server, window, windowPanes);
      if (paneId) return { resolved: true, agentType: cwdMatched.agentType, sessionId: cwdMatched.sessionId, paneId };
    }

    return { resolved: false, reason: 'no_recent_session' };
  }

  /** 優先順位1: タスク連携。session が存在しなければ null（呼び出し元がフォールバックする）。 */
  private async resolveViaTask(window: Window): Promise<{ agentType: string; sessionId: string } | null> {
    if (window.taskId === null) return null;
    const task = this.taskRepo.findById(window.taskId);
    if (!task || !task.agentSessionId) return null;

    const claudeSource = this.sources.find((s) => s.agentType === TASK_LINKED_AGENT_TYPE);
    if (!claudeSource) return null;

    const meta = claudeSource.getSessionCwd(task.agentSessionId);
    if (!meta) return null; // セッションファイルが実在しない（不正な session id を含む）

    return { agentType: TASK_LINKED_AGENT_TYPE, sessionId: task.agentSessionId };
  }

  /** 優先順位2: cwd 照合フォールバック。複数一致時は mtime 最新を採用。 */
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

  /** pane 未取得ならアクティブ pane 判定のため list-sessions を追加で1回引く（優先順位3、遅延評価）。 */
  private async resolvePaneId(server: ServerConfig, window: Window, windowPanes: TmuxPaneInfo[]): Promise<string | null> {
    if (windowPanes.length === 0) return null;
    if (windowPanes.some((p) => AGENT_COMMAND_PATTERN.test(p.currentCommand))) {
      return selectPane(windowPanes, null);
    }
    const activePaneIndex = await this.findActivePaneIndex(server, window);
    return selectPane(windowPanes, activePaneIndex);
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
