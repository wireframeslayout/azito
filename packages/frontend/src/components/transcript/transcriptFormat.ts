import type { TranscriptErrorResponse } from './transcriptTypes';

/** API レスポンスがエラー形状（{ error: string }）かどうかを判定する。 */
export function isErrorResponse<T>(result: T | TranscriptErrorResponse): result is TranscriptErrorResponse {
  return typeof result === 'object' && result !== null && 'error' in result;
}

/** 実パス（例: cwd）の末尾セグメントを取り出す。 */
export function pathBasename(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : fullPath;
}

/** タイムスタンプを表示用に整形する。同日ならHH:mm、それ以外は日付付き。不正な値は空文字。 */
export function formatEntryTimestamp(timestamp: string | null, language: string): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (!Number.isFinite(d.getTime())) return '';

  const now = new Date();
  const isSameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();

  if (isSameDay) {
    return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

/** タイムスタンプからローカル日付のキー（YYYY-M-D）を作る。日付セパレータの境界判定に使う。不正な値は null。 */
export function dateKeyOf(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 日付セパレータの表示ラベル（例: 8月9日（土）、ロケール依存）。不正な値は空文字。 */
export function formatDateSeparator(timestamp: string, language: string): string {
  const d = new Date(timestamp);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat(language, { month: 'long', day: 'numeric', weekday: 'short' }).format(d);
}

/**
 * 直前エントリとの経過秒数を算出する（thinking チップの秒数併記用、C2）。
 * 1〜300秒の範囲外、またはタイムスタンプが不正・欠落している場合は null を返す。
 */
export function computeThinkingGapSeconds(prevTimestamp: string | null, timestamp: string | null): number | null {
  if (!prevTimestamp || !timestamp) return null;
  const prevMs = new Date(prevTimestamp).getTime();
  const curMs = new Date(timestamp).getTime();
  if (!Number.isFinite(prevMs) || !Number.isFinite(curMs)) return null;
  const diffSec = Math.round((curMs - prevMs) / 1000);
  if (diffSec < 1 || diffSec > 300) return null;
  return diffSec;
}

export interface TextSegment {
  kind: 'text' | 'code';
  text: string;
  lang?: string;
}

/**
 * ```lang\n...\n``` 形式のフェンスドコードブロックを検出し、text/code のセグメントに分割する。
 * TUI スタイル（簡略 markdown: 改行・コードブロックのみ保持しそれ以外はプレーンテキスト表示）で使う。
 * 言語名は `c++`/`c#` のような記号を含む場合があるため `[^\r\n]*` で許容し、CRLF 改行にも対応する。
 */
export function splitCodeBlocks(text: string): TextSegment[] {
  const pattern = /```([^\r\n]*)\r?\n([\s\S]*?)```/g;
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    const lang = match[1].trim();
    segments.push({ kind: 'code', text: match[2].replace(/\r?\n$/, ''), lang: lang || undefined });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}
