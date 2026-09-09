import { type PaneHandle, muxRefFromTmuxTarget } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { IServerRepository } from '../servers/Server';
import type { IWindowRepository, Window } from '../windows/Window';
import { getAgentTranscriptProfile, type InterruptKey } from './sources/profiles';

// ─── Types ───

export type WindowInputResult = 'ok' | 'window_not_found' | 'pane_not_found';
export type WindowSignalResult = 'ok' | 'window_not_found' | 'pane_not_found';
/** `resolvePaneIndex` の結果。解決できた場合はそのペインの tmux ペイン index。 */
export type PaneIndexResult = number | 'window_not_found' | 'pane_not_found';

/**
 * AskUserQuestion ピッカーの選択肢番号キー（Issue #338 チャット内回答）。ピッカーは数字キー1発で
 * 該当選択肢を確定するため、選択肢の並び順に対応する '1'〜'9' だけを扱う。回答としての妥当性検証
 * （質問が生きているか・二重送出でないか）は routes.ts 側の責務で、ここは送出可能なキーの型のみ。
 */
export type AnswerKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

// ─── Helpers ───

function resolveWindowRef(window: Pick<Window, 'muxRef' | 'tmuxTarget'>) {
  return window.muxRef ?? muxRefFromTmuxTarget(window.tmuxTarget);
}

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
    private readonly muxDriverRegistry: MuxDriverRegistry,
    private readonly serverRepo: IServerRepository,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async sendInput(windowId: number, handle: PaneHandle, text: string): Promise<WindowInputResult> {
    const window = this.windowRepo.findById(windowId);
    if (!window) return 'window_not_found';

    const server = this.serverRepo.findByName(window.serverName);
    if (!server) return 'window_not_found';

    const driver = this.muxDriverRegistry.resolve(server);
    const belongsToWindow = await this.paneBelongsToWindow(driver, server, window, handle);
    if (!belongsToWindow) return 'pane_not_found';

    await this.preparePaneForInput(driver, server, handle);
    await driver.sendTextToHandle(server, handle, text);
    const submitDelayMs = this.resolveSubmitDelay(window.workerType);
    if (submitDelayMs > 0) await this.wait(submitDelayMs);
    await driver.sendKeysToHandle(server, handle, ['Enter']);
    return 'ok';
  }

  async sendSignal(windowId: number, handle: PaneHandle, action: 'interrupt' | 'key', key?: InterruptKey | AnswerKey): Promise<WindowSignalResult> {
    const window = this.windowRepo.findById(windowId);
    if (!window) return 'window_not_found';

    const server = this.serverRepo.findByName(window.serverName);
    if (!server) return 'window_not_found';

    const driver = this.muxDriverRegistry.resolve(server);
    const belongsToWindow = await this.paneBelongsToWindow(driver, server, window, handle);
    if (!belongsToWindow) return 'pane_not_found';

    await this.preparePaneForInput(driver, server, handle);
    const resolvedKey = action === 'interrupt' ? this.resolveInterruptKey(window.workerType) : (key as InterruptKey | AnswerKey);
    await driver.sendKeysToHandle(server, handle, [resolvedKey]);
    return 'ok';
  }

  /**
   * paneId が指すペインの tmux ペイン index を返す（Issue #338 チャット内回答）。ウィンドウに
   * 属さない paneId は 'pane_not_found'。回答送出では「クライアントが名指ししたペイン」と
   * 「hook シグナルが発火したペイン」の同一性を確かめる必要があり、両者は表現が違う
   * （%ID と index）ため、突合できる形へ揃えるのがこのメソッドの役割。判定そのもの
   * （一致しなければ回答を成立させない）は InteractionMonitor.consumePendingAnswer 側で、
   * 消費と同じ1ステップとして行う。
   */
  async resolvePaneIndex(windowId: number, paneId: string): Promise<PaneIndexResult> {
    const window = this.windowRepo.findById(windowId);
    if (!window) return 'window_not_found';

    const server = this.serverRepo.findByName(window.serverName);
    if (!server) return 'window_not_found';

    const driver = this.muxDriverRegistry.resolve(server);
    const pane = (await this.listWindowPanes(driver, server, window)).find((p) => p.paneId === paneId);
    return pane ? pane.paneIndex : 'pane_not_found';
  }

  /**
   * copy-mode 判定は MuxCapabilities.copyMode で分岐し、herdr/zellij は copy-mode 概念が
   * 無いため no-op。tmux ではスクロールバック閲覧中の send-keys がバッファ選択操作に吸収される
   * ため、解除してから短い待機を挟む。
   */
  private async preparePaneForInput(driver: IMuxClient, server: ServerConfig, handle: PaneHandle): Promise<void> {
    if (!driver.caps.copyMode) return;
    const inMode = await driver.isPaneInModeByHandle(server, handle);
    if (!inMode) return;
    await driver.cancelPaneModeByHandle(server, handle);
    await this.wait(100);
  }

  private async paneBelongsToWindow(driver: IMuxClient, server: ServerConfig, window: Window, paneId: string): Promise<boolean> {
    const windowPanes = await this.listWindowPanes(driver, server, window);
    return windowPanes.some((p) => p.paneId === paneId);
  }

  private async listWindowPanes(driver: IMuxClient, server: ServerConfig, window: Window) {
    const ref = resolveWindowRef(window);
    const allPanes = await driver.listAllPanes(server);
    return allPanes.filter((p) => p.sessionName === ref.workspace && windowSpecMatches(ref.window, p.windowIndex, p.windowName));
  }

  private resolveInterruptKey(workerType: string | null): InterruptKey {
    if (workerType === null) return 'C-c';
    return getAgentTranscriptProfile(workerType)?.interruptKey ?? 'C-c';
  }

  private resolveSubmitDelay(workerType: string | null): number {
    if (workerType === null) return 0;
    return getAgentTranscriptProfile(workerType)?.submitDelayMs ?? 0;
  }
}

function windowSpecMatches(windowSpec: string, windowIndex: number, windowName: string): boolean {
  for (const spec of new Set([windowSpec, windowSpec.replace(/\.\d+$/, '')])) {
    if (!spec) continue;
    if (/^\d+$/.test(spec) ? spec === String(windowIndex) : spec === windowName) return true;
  }
  return false;
}
