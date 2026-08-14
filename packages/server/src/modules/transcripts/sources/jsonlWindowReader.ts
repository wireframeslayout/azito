import fs from 'fs';

// ─── JSONL のバイト窓読み（純粋関数群） ───
//
// 旧 TranscriptService の初回読み・差分読み・行境界処理をエージェント非依存の形で切り出したもの。
// 「1行 → エントリ」の変換だけは呼び出し側の parseLine に委譲する。

export interface WindowReadResult<T> {
  entries: T[];
  nextOffset: number;
  truncated: boolean;
  /** 返却範囲の先頭バイト位置（後方ページング readBeforeWindow の before に渡す境界値）。 */
  startOffset: number;
  /** startOffset より前にまだ読んでいないデータがあるか（後方ページング可能か）。 */
  hasOlder: boolean;
}

export interface BeforeWindowReadResult<T> {
  entries: T[];
  /** 返却範囲の先頭バイト位置。次の後方ページングではこの値を before に渡す。 */
  prevOffset: number;
  /** prevOffset より前にまだ読んでいないデータがあるか。 */
  hasOlder: boolean;
}

/** ファイルの [position, position+length) を位置指定で読む。ファイル末尾を超える分は切り詰める。 */
export function readChunk(fd: number, size: number, position: number, length: number): Buffer {
  const start = Math.min(Math.max(position, 0), size);
  const readLength = Math.min(length, size - start);
  const buf = Buffer.alloc(Math.max(readLength, 0));
  if (buf.length > 0) {
    fs.readSync(fd, buf, 0, buf.length, start);
  }
  return buf;
}

export function findLastNewline(buf: Buffer): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) return i;
  }
  return -1;
}

/** [from, from+len) を読み、範囲内で最初に見つかった改行のファイル内絶対バイト位置を返す（無ければ -1）。 */
function findFirstNewlineAbsolute(fd: number, size: number, from: number, len: number): number {
  const buf = readChunk(fd, size, from, len);
  const idx = buf.indexOf(0x0a);
  return idx === -1 ? -1 : from + idx;
}

/**
 * buf[0, consumedLength) を行に分割し、各行のファイル内絶対バイト開始位置（base + buf内オフセット）を添える。
 * consumedLength が buf の途中（最終行が改行を含まない）でも、その末尾セグメントを最終行として含める
 * （readInitialWindow の「末尾の未完結行は消費しない」規則により、呼び出し側は consumedLength を
 * 常に「改行の直前」または 0 に設定するため、ここでの最終セグメントは実際には常に完結行になる）。
 */
function splitCompleteLinesWithOffsets(buf: Buffer, consumedLength: number, base: number): { line: string; start: number }[] {
  const region = buf.subarray(0, consumedLength);
  const result: { line: string; start: number }[] = [];
  let lineStart = 0;
  for (let i = 0; i < region.length; i++) {
    if (region[i] === 0x0a) {
      result.push({ line: region.subarray(lineStart, i).toString('utf-8'), start: base + lineStart });
      lineStart = i + 1;
    }
  }
  result.push({ line: region.subarray(lineStart).toString('utf-8'), start: base + lineStart });
  return result;
}

/**
 * 初回読み: ファイル末尾から最大 maxBytes バイトだけ位置指定で読む。
 * バイト数制限で頭を切った場合はその範囲内の最初の完全行から処理し、末尾の未完結行は消費しない
 * （差分読みと同じ規則: nextOffset = 最後の改行位置+1）。
 * tailLimit を超えるエントリ数は末尾側だけ残す（truncated に反映）。
 * startOffset は実際に返した先頭エントリの行開始バイト位置（エントリ数クリップがあればその位置まで
 * 前進する）。hasOlder は startOffset より前にまだデータが残っているか（バイト数クリップ or
 * エントリ数クリップのいずれかで true）。
 */
export function readInitialWindow<T>(
  fd: number,
  size: number,
  maxBytes: number,
  parseLine: (line: string, lineStart: number) => T | null,
  tailLimit: number,
): WindowReadResult<T> {
  const windowStart = Math.max(size - maxBytes, 0);
  const byteCapped = windowStart > 0;

  let readStart = windowStart;
  if (byteCapped) {
    // ウィンドウの先頭が行の途中から始まっている可能性があるため、最初の改行の直後までスキップする。
    const probe = readChunk(fd, size, windowStart, size - windowStart);
    const firstNewline = probe.indexOf(0x0a);
    readStart = firstNewline === -1 ? size : windowStart + firstNewline + 1;
  }

  const buf = readChunk(fd, size, readStart, size - readStart);
  const lastNewline = findLastNewline(buf);
  const consumedLength = lastNewline === -1 ? 0 : lastNewline;

  const entries: T[] = [];
  const entryOffsets: number[] = [];
  if (consumedLength > 0) {
    for (const { line, start } of splitCompleteLinesWithOffsets(buf, consumedLength, readStart)) {
      const entry = parseLine(line, start);
      if (entry) {
        entries.push(entry);
        entryOffsets.push(start);
      }
    }
  }

  const nextOffset = lastNewline === -1 ? readStart : readStart + lastNewline + 1;
  const tailEntries = entries.slice(-tailLimit);
  const entryTruncated = tailEntries.length < entries.length;
  const startOffset = entryTruncated ? entryOffsets[entryOffsets.length - tailEntries.length] : readStart;

  return {
    entries: tailEntries,
    nextOffset,
    truncated: byteCapped || entryTruncated,
    startOffset,
    hasOlder: byteCapped || entryTruncated,
  };
}

/**
 * 差分読み: offset 以降を最大 maxBytes バイトだけ位置指定で読み、
 * 読んだウィンドウ内の最後の改行位置までのみ消費する。ウィンドウを超える残りは
 * 次回のポーリング（返却された nextOffset を offset に指定した呼び出し）で取得される。
 */
export function readIncrementalWindow<T>(
  fd: number,
  size: number,
  offset: number,
  maxBytes: number,
  parseLine: (line: string, lineStart: number) => T | null,
): WindowReadResult<T> {
  const start = Math.min(Math.max(offset, 0), size);
  const buf = readChunk(fd, size, start, maxBytes);
  const lastNewline = findLastNewline(buf);

  if (lastNewline === -1) {
    return { entries: [], nextOffset: start, truncated: false, startOffset: start, hasOlder: start > 0 };
  }

  const entries: T[] = [];
  for (const { line, start: lineStart } of splitCompleteLinesWithOffsets(buf, lastNewline, start)) {
    const entry = parseLine(line, lineStart);
    if (entry) entries.push(entry);
  }

  return {
    entries,
    nextOffset: start + lastNewline + 1,
    truncated: false,
    startOffset: start,
    hasOlder: start > 0,
  };
}

/** readBeforeWindow のウィンドウ拡張上限（1回の呼び出しで遡る最大バイト数 = maxBytes の何倍か）。 */
const MAX_EXPAND_WINDOWS = 8;

/**
 * 後方ページング: before（呼び出し側が既に把握している行境界 — readInitialWindow/
 * readIncrementalWindow の startOffset や、この関数自身が返した prevOffset）より前を
 * 最大 maxBytes バイトだけ位置指定で読む。ウィンドウ先頭が行の途中から始まっている場合は
 * 最初の改行の直後までスキップし、before 直前の改行までの完全行だけをパースする。
 *
 * 直前レコード（before の直前の1行）が maxBytes を超える巨大行の場合、単一ウィンドウ内には
 * 改行が見つからない。この場合はウィンドウを maxBytes 単位でさらに前方へ拡張し、改行を探す
 * （最大 MAX_EXPAND_WINDOWS 窓 = maxBytes * MAX_EXPAND_WINDOWS バイトまで）。それでも見つからない
 * 場合のみ、その行は読み取り不能として丸ごとスキップする（cursor を拡張済みの範囲の先頭まで厳密に
 * 減少させ、無限ループを防止しつつ、さらに前方にデータがあれば hasOlder は維持する）。
 */
export function readBeforeWindow<T>(
  fd: number,
  size: number,
  before: number,
  maxBytes: number,
  parseLine: (line: string, lineStart: number) => T | null,
  options: { maxExpandWindows?: number } = {},
): BeforeWindowReadResult<T> {
  // 1 を渡すとオーバーサイズ行の窓拡張を無効化し、1回の呼び出しの読み取りを maxBytes の範囲
  // （プローブ＋本読みで最大2回走査）に厳密に閉じ込める。読み取り量に上限を課したい呼び出し元
  // （tail-state 走査）が使う。
  const expandLimit = Math.max(options.maxExpandWindows ?? MAX_EXPAND_WINDOWS, 1);
  const beforeClamped = Math.min(Math.max(before, 0), size);
  const windowStart = Math.max(beforeClamped - maxBytes, 0);
  const byteCapped = windowStart > 0;

  let readStart = windowStart;
  const hasOlder = byteCapped;

  if (byteCapped) {
    // beforeClamped-1 は「before の直前レコードの終端改行」そのものであり、before が正しい行境界で
    // ある限り常にそこに存在する。これを「見つかった改行」として扱うと、窓の中に他の改行が無い
    // （＝直前レコードが巨大行で窓を埋め尽くしている）場合でも readStart = beforeClamped となり
    // 0 バイト読みで前進しなくなる。そのため最初の探索ではこの末尾1バイトを除外する。
    const searchEnd = beforeClamped - 1;
    let curWindowStart = windowStart;
    let newlineAbs =
      searchEnd > curWindowStart ? findFirstNewlineAbsolute(fd, size, curWindowStart, searchEnd - curWindowStart) : -1;
    let windows = 1;
    while (newlineAbs === -1 && curWindowStart > 0 && windows < expandLimit) {
      const nextWindowStart = Math.max(curWindowStart - maxBytes, 0);
      newlineAbs = findFirstNewlineAbsolute(fd, size, nextWindowStart, curWindowStart - nextWindowStart);
      curWindowStart = nextWindowStart;
      windows++;
    }

    if (newlineAbs === -1) {
      // 上限まで遡っても改行が見つからない: このレコードは読み取り不能としてスキップする。
      // cursor は curWindowStart（今回探索した範囲の先頭）まで厳密に減少させ、その手前にまだ
      // データがあれば hasOlder を維持する（次回呼び出しでさらに遡れる）。
      return { entries: [], prevOffset: curWindowStart, hasOlder: curWindowStart > 0 };
    }
    readStart = newlineAbs + 1;
  }

  const buf = readChunk(fd, size, readStart, beforeClamped - readStart);
  const entries: T[] = [];
  for (const { line, start: lineStart } of splitCompleteLinesWithOffsets(buf, buf.length, readStart)) {
    const entry = parseLine(line, lineStart);
    if (entry) entries.push(entry);
  }

  return { entries, prevOffset: readStart, hasOlder };
}
