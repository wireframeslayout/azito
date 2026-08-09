// 会話ビューの入力バーの送信履歴を localStorage に永続化するユーティリティ（F4）。
// 全セッション共通の1つの履歴として扱う（下書きとは異なりセッション毎に分けない）。

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
