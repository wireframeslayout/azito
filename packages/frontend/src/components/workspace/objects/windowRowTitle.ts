/**
 * ウィンドウ行の検索テキスト構築（純関数）。
 *
 * 表示系の関数（resolveWindowDisplay, resolvePaneDisplayTitle 等）は
 * lib/windowDisplay.ts に移動済み。
 */

import { formatWindowId } from '@azito/shared';
import { resolvePaneDisplayTitle } from '../../../lib/windowDisplay';

export interface WindowSearchTextInput {
  paneTitle?: string;
  paneCommand?: string;
  label?: string;
  taskTitle?: string;
  tmuxTarget: string;
  serverName: string;
  taskId?: number;
  windowId?: number;
  branch?: string;
  worktreeBranch?: string;
}

/**
 * 行の検索対象テキスト（小文字化・空要素除去済み）。主表示になったペインタイトルでも
 * 検索できるよう、実ペインタイトルを含める。
 */
export function buildWindowSearchText(input: WindowSearchTextInput): string {
  const { paneTitle, paneCommand, label, tmuxTarget, serverName, taskId, taskTitle, branch, worktreeBranch, windowId } = input;
  return [
    resolvePaneDisplayTitle(paneTitle, paneCommand),
    label, tmuxTarget, serverName,
    taskId != null ? `#${taskId}` : undefined,
    taskTitle, branch, worktreeBranch,
    windowId != null ? formatWindowId(windowId) : undefined,
    windowId != null ? `w${windowId}` : undefined,
    windowId != null ? String(windowId) : undefined,
  ].filter(Boolean).join(' ').toLowerCase();
}
