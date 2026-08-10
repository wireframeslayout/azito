// 会話ビューの入力バーの送信履歴を localStorage に永続化するユーティリティ（F4）。
// 全セッション共通の1つの履歴として扱う（下書きとは異なりセッション毎に分けない）。
//
// Issue #69 仕様調整4: ↑↓/🕘 履歴の主ソースはこの localStorage 履歴ではなく、会話トランスクリプト
// 自体の user 発話（deriveContextHistory、下部）に変更した。localStorage 履歴は、セッション未確立
// （pane-only モード等）でトランスクリプトを取得できない場合のフォールバックとしてのみ使う。
// pushHistory は送信の都度そのフォールバック用に貯め続ける（優先度の詳細は PromptInputBar 側）。

import type { TranscriptEntry } from './transcriptTypes';

const HISTORY_KEY = 'azito.transcript.inputHistory';
const MAX_HISTORY = 50;

/** 保存済み履歴を新しい順で返す。破損データ・localStorage 不可時は空配列。 */
export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * 送信テキストを履歴の先頭に追加する。完全一致する既存エントリは削除してから
 * 先頭に繰り上げる（重複を残さない）。最大 MAX_HISTORY 件を超える古いものは切り捨てる。
 */
export function pushHistory(text: string): void {
  if (text.length === 0) return;
  try {
    const existing = loadHistory().filter((entry) => entry !== text);
    const next = [text, ...existing].slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可時は履歴保存をスキップする（送信自体は継続する）。
  }
}

/** 合成メッセージ（`<task-notification>`/`<system-reminder>`/`<command-message>` 等）の簡易判定。 */
function isSyntheticMessage(text: string): boolean {
  return text.trimStart().startsWith('<');
}

/**
 * トランスクリプトの user 発話から入力履歴を導出する（Issue #69 仕様調整4）。
 * 各 user エントリの text ブロックを結合したものを新しい順で返す。以下は除外する。
 * - 結合後が空文字のエントリ
 * - `<...>` で始まる合成メッセージ（task-notification/system-reminder/command-message 等）
 * - 完全一致の重複（連続でなくても、新しい順に見て初出以外は捨てる単純な一意化。
 *   古い重複を新しい位置へ繰り上げることはしない）
 * 上限 MAX_HISTORY 件。
 */
export function deriveContextHistory(entries: TranscriptEntry[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'user') continue;
    const text = entry.blocks
      .filter((block) => block.kind === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text.length === 0) continue;
    if (isSyntheticMessage(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= MAX_HISTORY) break;
  }
  return result;
}
