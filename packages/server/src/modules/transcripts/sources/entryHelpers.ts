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
 * 正規化済み TranscriptEntry 1件を稼働状態（in_progress/terminal）に分類する。両ソースの
 * getSessionTailState から共有される — Codex の 'reasoning' response_item は normalizeResponseItem
 * によって Claude の thinking ブロックと同じ type:'assistant' 形へ正規化されるため、この分類ロジックは
 * エージェント非依存で成立する。
 *
 * - interrupted: 中断マーカー → terminal（応答待ち/実行中ではない）
 * - user: ユーザー発話 → in_progress（エージェントの応答待ち）
 * - tool: tool_result（Claude は role=user の tool_result のみ、Codex は function_call/
 *   function_call_output 等） → in_progress（次のターン待ち、または実行中）
 * - assistant: 最後のブロックが text → terminal（最終応答が完了している）。tool_use →
 *   in_progress（ツール呼び出し中）。thinking → in_progress（Codex の reasoning はターン途中の
 *   中間出力として頻出し、その直後に function_call や最終 text が続く途中経過にすぎないため、
 *   thinking で終わっていても「応答完了」とは言えない — terminal と誤判定すると、実際にはまだ
 *   考え中/実行中のエージェントをポーリングタイミング次第で idle に倒してしまう）
 * - system/other: 判定材料として弱いレコードのため、旧来の mtime のみの判定（working 扱い）を維持する
 *   意図で in_progress を返す（誤って「応答完了」と判定し working 表示を消してしまわないため）
 */
export function classifyTailEntry(entry: TranscriptEntry): 'in_progress' | 'terminal' {
  if (entry.type === 'interrupted') return 'terminal';
  if (entry.type === 'user') return 'in_progress';
  if (entry.type === 'tool') return 'in_progress';
  if (entry.type === 'assistant') {
    const lastBlock = entry.blocks[entry.blocks.length - 1];
    return lastBlock?.kind === 'text' ? 'terminal' : 'in_progress';
  }
  return 'in_progress';
}
