import type { ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import { windowSpecMatches } from '../tmux/TmuxClient';
import type { IServerRepository } from '../servers/Server';
import type { IWindowRepository, Window } from '../windows/Window';
import { getAgentTranscriptProfile, type InterruptKey } from './sources/profiles';
import { splitWindowTarget } from './WindowSessionResolver';

// ─── Types ───

export type WindowInputResult = 'ok' | 'window_not_found' | 'pane_not_found';
export type WindowSignalResult = 'ok' | 'window_not_found' | 'pane_not_found';

/**
 * AskUserQuestion ピッカーの選択肢番号キー（Issue #338 チャット内回答）。ピッカーは数字キー1発で
 * 該当選択肢を確定するため、選択肢の並び順に対応する '1'〜'9' だけを扱う。回答としての妥当性検証
 * （質問が生きているか・二重送出でないか）は routes.ts 側の責務で、ここは送出可能なキーの型のみ。
 */
export type AnswerKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

// ─── Service ───

/**
 * セッション（トランスクリプト JSONL）の存在を前提とせず、ウィンドウに紐づく pane へ直接
 * テキスト送信・制御キー送出を行うサービス（Issue #69 仕様調整3）。TranscriptPaneService は
 * セッションID起点（cwd 突合による候補提示・claude 固定）だが、こちらはウィンドウ起点で
 * 「そのウィンドウの実在」「pane の実在」だけを検証する — セッション JSONL がまだ無い
 * （会話履歴が発生する前）ウィンドウからでもチャットを開始できるようにするための経路。
 */
export class WindowInputService {
  constructor(
    private readonly windowRepo: IWindowRepository,
    private readonly tmuxClient: TmuxClient,
    private readonly serverRepo: IServerRepository,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async sendInput(windowId: number, paneId: string, text: string): Promise<WindowInputResult> {
    const window = this.windowRepo.findById(windowId);
    if (!window) return 'window_not_found';

    const server = this.serverRepo.findByName(window.serverName);
    if (!server) return 'window_not_found';

    const belongsToWindow = await this.paneBelongsToWindow(server, window, paneId);
    if (!belongsToWindow) return 'pane_not_found';

    await this.preparePaneForInput(server, paneId);
    await this.tmuxClient.sendLiteralText(server, paneId, text);
    const submitDelayMs = this.resolveSubmitDelay(window.workerType);
    if (submitDelayMs > 0) await this.wait(submitDelayMs);
    await this.tmuxClient.sendKeys(server, paneId, ['Enter']);
    return 'ok';
  }

  async sendSignal(windowId: number, paneId: string, action: 'interrupt' | 'key', key?: InterruptKey | AnswerKey): Promise<WindowSignalResult> {
    const window = this.windowRepo.findById(windowId);
    if (!window) return 'window_not_found';

    const server = this.serverRepo.findByName(window.serverName);
    if (!server) return 'window_not_found';

    const belongsToWindow = await this.paneBelongsToWindow(server, window, paneId);
    if (!belongsToWindow) return 'pane_not_found';

    await this.preparePaneForInput(server, paneId);
    const resolvedKey = action === 'interrupt' ? this.resolveInterruptKey(window.workerType) : (key as InterruptKey | AnswerKey);
    await this.tmuxClient.sendKeys(server, paneId, [resolvedKey]);
    return 'ok';
  }

  /**
   * 送信直前のペイン準備ステップ（Issue #69 T12）。将来 tmux 以外のマルチプレクサに差し替える計画
   * があるため、意図（「入力できる状態にする」）をこのメソッド名で表し、tmux 固有の copy-mode
   * 判定/解除ロジックは TmuxClient 側に隔離する — IMultiplexer のような抽象は現時点では過剰
   * （実装は tmux の1系統のみ。「tmuxラッパーと割り切る」方針）なので新設せず、このメソッド境界
   * だけを将来の抽出点として用意する。copy-mode 中（スクロールバック閲覧中）は send-keys のリテラル
   * 入力がバッファ選択操作に吸収され対象アプリに届かないため、解除してから短い待機を挟む。
   */
  private async preparePaneForInput(server: ServerConfig, paneId: string): Promise<void> {
    const inMode = await this.tmuxClient.isPaneInMode(server, paneId);
    if (!inMode) return;
    await this.tmuxClient.cancelPaneMode(server, paneId);
    await this.wait(100);
  }

  /**
   * paneId が実在するだけでなく、指定ウィンドウ（window.tmuxTarget）に属する pane であることを検証する
   * （Important #1: 帰属未検証だと細工した paneId で別ウィンドウの任意ペインへ送信・割込ができてしまう）。
   * ウィンドウ側の pane 集合は WindowSessionResolver.getWindowPanes と同じロジック（session 名 +
   * windowSpecMatches によるウィンドウ特定）で解決する。
   */
  private async paneBelongsToWindow(server: ServerConfig, window: Window, paneId: string): Promise<boolean> {
    const { sessionName, windowSpec } = splitWindowTarget(window.tmuxTarget);
    const allPanes = await this.tmuxClient.listAllPanes(server);
    const windowPanes = allPanes.filter((p) => p.sessionName === sessionName && windowSpecMatches(windowSpec, p.windowIndex, p.windowName));
    return windowPanes.some((p) => p.paneId === paneId);
  }

  /**
   * workerType に対応する AgentTranscriptProfile の interruptKey を採用する。プロファイルが
   * 無い workerType（generic、または未知の値）は 'C-c' を既定にする — 既存 /signal ルート
   * （TranscriptPaneService.sendSignal）はプロファイル必須で 400 にするが、ウィンドウ直接入力は
   * プレーンシェルへの割り込みも成立させたい。Escape はシェルに対しては無効な一方、
   * Ctrl+C はシェル・大半の CLI エージェント双方で有効な汎用割り込みキーのため、これを既定とする。
   */
  private resolveInterruptKey(workerType: string | null): InterruptKey {
    if (workerType === null) return 'C-c';
    return getAgentTranscriptProfile(workerType)?.interruptKey ?? 'C-c';
  }

  /**
   * workerType に対応する AgentTranscriptProfile の submitDelayMs を採用する。プロファイルが
   * 無い workerType（generic、または未知の値）・ウィンドウは待ちなし（0）を既定にする —
   * リテラル送信直後に Enter が届いても支障のない従来挙動を維持する。
   */
  private resolveSubmitDelay(workerType: string | null): number {
    if (workerType === null) return 0;
    return getAgentTranscriptProfile(workerType)?.submitDelayMs ?? 0;
  }
}
