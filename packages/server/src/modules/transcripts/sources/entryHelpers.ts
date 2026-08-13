// Claude / Codex 両ソースで共有する正規化ヘルパー（トリム制限・型ガード）。

import type { TranscriptEntry } from './TranscriptSource';

export const TOOL_USE_INPUT_LIMIT = 2000;
export const TOOL_RESULT_TEXT_LIMIT = 4000;

/** getSessionTailState の末尾窓読み取りバイト数（両ソース共通）。読み取り窓を小さく保つための上限。 */
export const TAIL_STATE_SCAN_BYTES = 16 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * 正規化済み TranscriptEntry 1件を稼働状態（in_progress/terminal_interrupted/terminal_local/
 * terminal_final）に分類する。両ソースの getSessionTailState から共有される — Codex の
 * 'reasoning' response_item は normalizeResponseItem によって Claude の thinking ブロックと同じ
 * type:'assistant' 形へ正規化されるため、この分類ロジックはエージェント非依存で成立する。
 *
 * terminal を複数値に分けている理由（Issue #338 followup 退行修正）: 停止ボタンによる中断マーカー
 * 書き込み自体が mtime を更新してしまい、mtime だけでは「稼働中」の偽陽性が生じる（これが本来
 * terminal ゲートで潰したかったケース）。一方、正常完了直後（assistant の最終応答で終わる）は、
 * mtime 120秒窓の間 working のまま見せ続けたい（completed 行の合成に必要な観測窓のため） —
 * ここを一律 terminal 扱いにすると、短時間で完了したターンが working を一度も観測されず稼働
 * リストに現れなくなる（今回の退行）。そのため呼び出し元（WindowSessionResolver.getActivityStatus）
 * は terminal_interrupted / terminal_local のみを idle の根拠にし、terminal_final は working の
 * まま扱う。
 *
 * - interrupted: 中断マーカー（停止ボタン等） → terminal_interrupted（応答待ち/実行中ではない。
 *   mtime が新しくても idle に倒してよいケース）
 * - command: ローカルコマンド実行（例: /model） → terminal_local（エージェントのターンを開始せず
 *   制御をユーザーに返した状態。ユーザーによる中断ではないため terminal_interrupted には含めないが、
 *   ターンが開始していない以上 working として見せ続ける理由もないため idle の根拠にする —
 *   Issue #338 コードレビュー指摘: ローカルコマンド完了だけで mtime 更新→120秒 working になる
 *   偽 working を防ぐ）
 * - interaction: AskUserQuestion 等の質問＋回答確定イベント → in_progress（回答後もエージェントは
 *   ターンを継続するため、tool_result と同様に応答待ち/実行中とみなす）
 * - user: ユーザー発話 → in_progress（エージェントの応答待ち）
 * - tool: tool_result（Claude は role=user の tool_result のみ、Codex は function_call/
 *   function_call_output 等） → in_progress（次のターン待ち、または実行中）
 * - assistant: 最後のブロックが text → terminal_final（最終応答が完了している）。tool_use →
 *   in_progress（ツール呼び出し中）。thinking → in_progress（Codex の reasoning はターン途中の
 *   中間出力として頻出し、その直後に function_call や最終 text が続く途中経過にすぎないため、
 *   thinking で終わっていても「応答完了」とは言えない — terminal_final と誤判定すると、実際には
 *   まだ考え中/実行中のエージェントをポーリングタイミング次第で idle に倒してしまう）
 * - system/other: 判定材料として弱いレコードのため、旧来の mtime のみの判定（working 扱い）を維持する
 *   意図で in_progress を返す（誤って「応答完了」と判定し working 表示を消してしまわないため）。
 *   systemKind: 'task_notification'（バックグラウンドタスク完了通知）もこの規律に従い in_progress
 *   （この通知はエージェントのターンを再開させるため、応答完了とはみなさない） — 明示的な分岐は
 *   置かず、下の system/other フォールスルーに委ねる。
 */
export function classifyTailEntry(
  entry: TranscriptEntry,
): 'in_progress' | 'terminal_interrupted' | 'terminal_local' | 'terminal_final' {
  if (entry.type === 'interrupted') return 'terminal_interrupted';
  if (entry.type === 'command') return 'terminal_local';
  if (entry.type === 'interaction') return 'in_progress';
  if (entry.type === 'user') return 'in_progress';
  if (entry.type === 'tool') return 'in_progress';
  if (entry.type === 'assistant') {
    const lastBlock = entry.blocks[entry.blocks.length - 1];
    return lastBlock?.kind === 'text' ? 'terminal_final' : 'in_progress';
  }
  return 'in_progress';
}
