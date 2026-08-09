// 会話ビューの入力バー下書きを localStorage に永続化するユーティリティ（F2）。
// セッション毎にキーを分け、300msデバウンス保存は呼び出し側（PromptInputBar）の責務とする。

const DRAFT_KEY_PREFIX = 'azito.transcript.draft.';

function draftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

/** 保存済み下書きを読む。未保存 or localStorage 不可時は空文字を返す。 */
export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? '';
  } catch {
    // プライベートブラウジング等で localStorage が使えない場合は下書き機能自体を無効化する
    // （下書き保存は補助機能であり、必須データの欠落ではない）。
    return '';
  }
}

/** 下書きを保存する。空文字は「下書きなし」を意味するためエントリごと削除する。 */
export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text === '') {
      localStorage.removeItem(draftKey(sessionId));
      return;
    }
    localStorage.setItem(draftKey(sessionId), text);
  } catch {
    // 上記と同様、保存できなくても入力自体は継続する。
  }
}

/** 送信成功時などに下書きを明示的に破棄する。 */
export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(draftKey(sessionId));
  } catch {
    // 上記と同様。
  }
}
