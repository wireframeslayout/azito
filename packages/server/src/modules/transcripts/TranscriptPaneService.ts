import { isPaneHandleLike, muxKindForRuntime, type MuxDriverKind, type PaneHandle } from '@azito/shared';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
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
    private readonly muxDriverRegistry: MuxDriverRegistry,
    private readonly serverRepo: IServerRepository,
  ) {}

  /** ローカルサーバー（type=local）の一覧。無いのは構成不整合としてエラーにする。 */
  private listLocalServers(): ServerConfig[] {
    const locals = this.serverRepo.findAll().filter((s) => s.type === 'local');
    if (locals.length === 0) throw new Error('No local server is configured');
    return locals;
  }

  /**
   * ローカルサーバーを mux 種別ごとに 1 台へ絞る（tmux の local は同じ tmux を見るため先頭 1 台で
   * 足りる。misao の local とは別のデーモンを見る）。
   */
  private listLocalServersByKind(): ServerConfig[] {
    const byKind = new Map<MuxDriverKind, ServerConfig>();
    for (const server of this.listLocalServers()) {
      const kind = muxKindForRuntime(server.muxRuntime);
      if (!byKind.has(kind)) byKind.set(kind, server);
    }
    return [...byKind.values()];
  }

  /** handle の形式と同じ mux 種別のローカルサーバーを返す。該当が無ければ undefined。 */
  private findLocalServerForHandle(handle: PaneHandle): ServerConfig | undefined {
    return this.listLocalServersByKind().find((s) => isPaneHandleLike(handle, muxKindForRuntime(s.muxRuntime)));
  }

  async listPaneCandidates(sessionId: string): Promise<PaneCandidatesResult | null> {
    const meta = this.claudeTranscriptSource.getSessionCwd(sessionId);
    if (!meta) return null;

    const allPanes = (
      await Promise.all(
        this.listLocalServersByKind().map((server) => this.muxDriverRegistry.resolve(server).listAllPanes(server)),
      )
    ).flat();
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

    const server = this.findLocalServerForHandle(handle);
    if (!server) return 'pane_not_found';
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

    const server = this.findLocalServerForHandle(handle);
    if (!server) return 'pane_not_found';
    const driver = this.muxDriverRegistry.resolve(server);
    const { alive } = await driver.probePane(server, handle);
    if (!alive) return 'pane_not_found';

    await driver.sendKeysToHandle(server, handle, [key]);
    return 'ok';
  }
}
