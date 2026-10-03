import type { PaneHandle } from '@azito/shared';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { IWindowRepository } from '../windows/Window';
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
    private readonly muxDriverRegistry: MuxDriverRegistry,
    private readonly serverRepo: IServerRepository,
    private readonly windowRepo: IWindowRepository,
  ) {}

  /**
   * セッションの cwd に対応するローカルサーバーの ServerConfig を取得する。トランスクリプトは
   * ローカルの `~/.claude/projects` 配下のみを走査するため、対応するペインも常にローカル。
   * local が1台ならそれを使う。複数ある場合は、workingDirectory が cwd と一致する窓行を持つ
   * local サーバーを使う（一致なし・cwd 不明は決められないのでエラー）。local が無いのは構成
   * 不整合としてエラーにする（フォールバックで空候補を返して隠さない）。
   */
  private findLocalServer(cwd: string | null): ServerConfig {
    const locals = this.serverRepo.findAll().filter((s) => s.type === 'local');
    if (locals.length === 0) throw new Error('No local server is configured');
    if (locals.length === 1) return locals[0];

    const matched = cwd === null ? undefined : this.windowRepo.findAll().find(
      (w) => w.workingDirectory === cwd && locals.some((s) => s.name === w.serverName),
    );
    const server = matched && locals.find((s) => s.name === matched.serverName);
    if (!server) throw new Error('Cannot determine which local server holds the session: no window matches its cwd');
    return server;
  }

  async listPaneCandidates(sessionId: string): Promise<PaneCandidatesResult | null> {
    const meta = this.claudeTranscriptSource.getSessionCwd(sessionId);
    if (!meta) return null;

    const server = this.findLocalServer(meta.cwd);
    const driver = this.muxDriverRegistry.resolve(server);
    const allPanes = await driver.listAllPanes(server);
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

  async sendInput(sessionId: string, handle: PaneHandle, text: string): Promise<SendInputResult> {
    const meta = this.claudeTranscriptSource.getSessionCwd(sessionId);
    if (!meta) return 'session_not_found';

    const server = this.findLocalServer(meta.cwd);
    const driver = this.muxDriverRegistry.resolve(server);
    const { alive } = await driver.probePane(server, handle);
    if (!alive) return 'pane_not_found';

    await driver.sendTextToHandle(server, handle, text);
    await driver.sendKeysToHandle(server, handle, ['Enter']);
    return 'ok';
  }

  /**
   * 指定ペインへ割り込み/制御キー（Esc・Ctrl+C 相当）を送出する。sendInput と異なり cwd 一致は
   * 前提にしないため、対応する TranscriptSource は呼び出し元（routes）が agentType から解決して
   * 渡す — sendInput/listPaneCandidates が claude 固定で構築時注入の claudeTranscriptSource を使うのとは
   * 意図的に別経路にし、claude 以外のエージェント種別（プロファイルさえあれば codex 等）でも
   * 正しくセッション存在確認できるようにしている。
   */
  async sendSignal(source: TranscriptSource, sessionId: string, handle: PaneHandle, key: InterruptKey): Promise<SendSignalResult> {
    const meta = source.getSessionCwd(sessionId);
    if (!meta) return 'session_not_found';

    const server = this.findLocalServer(meta.cwd);
    const driver = this.muxDriverRegistry.resolve(server);
    const { alive } = await driver.probePane(server, handle);
    if (!alive) return 'pane_not_found';

    await driver.sendKeysToHandle(server, handle, [key]);
    return 'ok';
  }
}
