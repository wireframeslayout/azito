// Claude / Codex 両ソースで共有する正規化ヘルパー（トリム制限・型ガード）。

import type { SessionTailState, TranscriptEntry } from './TranscriptSource';
import { readBeforeWindow } from './jsonlWindowReader';

export const TOOL_USE_INPUT_LIMIT = 2000;
export const TOOL_RESULT_TEXT_LIMIT = 4000;

/**
 * getSessionTailState の末尾走査ウィンドウ段階（両ソース共通）。
 *
 * 実セッションの末尾は attachment（1件で数KB〜）や ai-title/file-history-snapshot といった
 * housekeeping レコードで埋まることが常態で、16KB の単発窓では意味のあるエントリに届かず
 * 'unknown' を返してしまう（実測: 25KB のセッションで user 発話 627B の後ろに attachment 5件
 * 約24KB が続き、回答待ちバナーの in_progress ゲートも Tier 4 の working 判定も沈黙した）。
 * そのため 16KB で決着しなければ 64KB → 256KB と窓を広げて再走査する。
 *
 * 走査コストの注記: エスカレーションは「16KB で決まらなかった場合のみ」発生する。稼働ポーリングは
 * WindowActivityStatusService の60秒キャッシュ配下、チャットの回答待ちゲートは pending シグナルが
 * 立っているときだけ読む構造なので、この追加読みの頻度は許容範囲にとどまる。
 */
export const TAIL_STATE_SCAN_WINDOWS = [16 * 1024, 64 * 1024, 256 * 1024] as const;

/** 後方互換の別名: 最初の（最小の）走査窓サイズ。 */
export const TAIL_STATE_SCAN_BYTES = TAIL_STATE_SCAN_WINDOWS[0];

/**
 * ファイル末尾からエスカレーション後方スキャンで最初の意味あるエントリを探し、稼働状態に分類する。
 * TAIL_STATE_SCAN_WINDOWS の各段階で readBeforeWindow（AskUserQuestion の有界後方スキャンと同じ
 * 読み取り器）により末尾ウィンドウをパースし、その中の最後のエントリから遡って分類する。
 * 最大窓（256KB）まで広げても意味あるエントリが無ければ 'unknown' を返す。
 */
export function scanSessionTailState(
  fd: number,
  size: number,
  parseLine: (line: string, lineStart: number) => TranscriptEntry | null,
): SessionTailState {
  for (const windowBytes of TAIL_STATE_SCAN_WINDOWS) {
    // readBeforeWindow は parseLine が null を返した行（housekeeping・壊れた行）を落とすため、
    // 返却された最後のエントリがそのまま「末尾の意味あるエントリ」になる。
    const { entries, hasOlder } = readBeforeWindow(fd, size, size, windowBytes, parseLine);
    const entry = entries[entries.length - 1];
    if (entry) return { state: classifyTailEntry(entry), lastEntryTimestampMs: parseEntryTimestampMs(entry) };
    // ウィンドウがファイル先頭に到達していれば、これ以上広げても読むものは無い。
    if (!hasOlder) break;
  }
  return { state: 'unknown', lastEntryTimestampMs: null };
}

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
 * terminal を複数値に分けている理由: 呼び出し元（WindowSessionResolver.getActivityStatus）が
 * 「終わり方」で扱いを変えるため。terminal_interrupted（停止ボタン等の中断）／terminal_local
 * （/model 等のローカルコマンド完了）は idle にするだけだが、terminal_final（エージェントの最終応答
 * で終わっている＝正常完了）はそのエントリの timestamp を「完了時刻」として上位へ渡し、
 * AgentActivityMonitor が reason='completed' の遷移を発行する根拠にする（P3）。いずれの terminal も
 * working としては扱わない — 以前は terminal_final を120秒間 working に偽装して
 * 「working→非working 遷移」をフロントに観測させていたが、その観測窓ハックは廃止した。
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
/** entry.timestamp（ISO 文字列 or null）を epoch ms に変換する。無い/不正な日時なら null。 */
export function parseEntryTimestampMs(entry: TranscriptEntry): number | null {
  if (!entry.timestamp) return null;
  const ms = Date.parse(entry.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

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
