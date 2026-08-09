import type { TmuxClient } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { InterruptKey } from './sources/profiles';

// ─── Types ───

export interface PaneCandidate {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  currentPath: string;
  currentCommand: string;
  /** cwd がセッションの記録済み cwd と完全一致するか。false でも候補として提示する。 */
  cwdMatch: boolean;
}

export interface PaneCandidatesResult {
  cwd: string | null;
  panes: PaneCandidate[];
}

export type SendInputResult = 'ok' | 'session_not_found' | 'pane_not_found';
export type SendSignalResult = 'ok' | 'session_not_found' | 'pane_not_found';

// ─── Service ───

/**
 * トランスクリプトのセッションと、それが動いている可能性のある tmux ペインを
 * cwd ベースで橋渡しするサービス。セッション→ペインの確実な対応表は存在しないため、
 * 候補提示（cwdMatch）＋ユーザー選択（paneId 指定）という前提で設計している。
 */
export class TranscriptPaneService {
  constructor(
    private readonly claudeTranscriptSource: TranscriptSource,
    private readonly tmuxClient: TmuxClient,
    private readonly serverRepo: IServerRepository,
  ) {}

  /**
   * ローカルサーバーの ServerConfig を取得する。トランスクリプトはローカルの
   * `~/.claude/projects` 配下のみを走査するため、対応する tmux ペインも常にローカル。
   * seed migration（003）で必ず1件作成されるため、見つからない場合は構成不整合として
   * エラーにする（フォールバックで空候補を返して隠さない）。
   */
  private findLocalServer(): ServerConfig {
    const server = this.serverRepo.findAll().find((s) => s.type === 'local');
    if (!server) throw new Error('No local server is configured');
    return server;
  }

  async listPaneCandidates(sessionId: string): Promise<PaneCandidatesResult | null> {
    const meta = this.claudeTranscriptSource.getSessionCwd(sessionId);
    if (!meta) return null;

    const server = this.findLocalServer();
    const allPanes = await this.tmuxClient.listAllPanes(server);
    const panes: PaneCandidate[] = allPanes.map((pane) => ({
      paneId: pane.paneId,
      sessionName: pane.sessionName,
      windowIndex: pane.windowIndex,
      windowName: pane.windowName,
      paneIndex: pane.paneIndex,
      currentPath: pane.currentPath,
      currentCommand: pane.currentCommand,
      cwdMatch: meta.cwd !== null && pane.currentPath === meta.cwd,
    }));

    return { cwd: meta.cwd, panes };
  }

  async sendInput(sessionId: string, paneId: string, text: string): Promise<SendInputResult> {
    const meta = this.claudeTranscriptSource.getSessionCwd(sessionId);
    if (!meta) return 'session_not_found';

    const server = this.findLocalServer();
    const exists = await this.tmuxClient.checkPaneExists(server, paneId);
    if (!exists) return 'pane_not_found';

    await this.tmuxClient.sendLiteralText(server, paneId, text);
    await this.tmuxClient.sendKeys(server, paneId, ['Enter']);
    return 'ok';
  }

  /**
   * 指定ペインへ割り込み/制御キー（Esc・Ctrl+C 相当）を送出する。sendInput と異なり cwd 一致は
   * 前提にしないため、対応する TranscriptSource は呼び出し元（routes）が agentType から解決して
   * 渡す — sendInput/listPaneCandidates が claude 固定で構築時注入の claudeTranscriptSource を使うのとは
   * 意図的に別経路にし、claude 以外のエージェント種別（プロファイルさえあれば codex 等）でも
   * 正しくセッション存在確認できるようにしている。
   */
  async sendSignal(source: TranscriptSource, sessionId: string, paneId: string, key: InterruptKey): Promise<SendSignalResult> {
    const meta = source.getSessionCwd(sessionId);
    if (!meta) return 'session_not_found';

    const server = this.findLocalServer();
    const exists = await this.tmuxClient.checkPaneExists(server, paneId);
    if (!exists) return 'pane_not_found';

    await this.tmuxClient.sendKeys(server, paneId, [key]);
    return 'ok';
  }
}
