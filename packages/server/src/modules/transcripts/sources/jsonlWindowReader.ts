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
  parseLine: (line: string) => T | null,
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
      const entry = parseLine(line);
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
  parseLine: (line: string) => T | null,
): WindowReadResult<T> {
  const start = Math.min(Math.max(offset, 0), size);
  const buf = readChunk(fd, size, start, maxBytes);
  const lastNewline = findLastNewline(buf);

  if (lastNewline === -1) {
    return { entries: [], nextOffset: start, truncated: false, startOffset: start, hasOlder: start > 0 };
  }

  const consumed = buf.subarray(0, lastNewline).toString('utf-8');
  const entries: T[] = [];
  for (const line of consumed.split('\n')) {
    const entry = parseLine(line);
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

/**
 * 後方ページング: before（呼び出し側が既に把握している行境界 — readInitialWindow/
 * readIncrementalWindow の startOffset や、この関数自身が返した prevOffset）より前を
 * 最大 maxBytes バイトだけ位置指定で読む。ウィンドウ先頭が行の途中から始まっている場合は
 * 最初の改行の直後までスキップし、before 直前の改行までの完全行だけをパースする。
 */
export function readBeforeWindow<T>(
  fd: number,
  size: number,
  before: number,
  maxBytes: number,
  parseLine: (line: string) => T | null,
): BeforeWindowReadResult<T> {
  const beforeClamped = Math.min(Math.max(before, 0), size);
  const windowStart = Math.max(beforeClamped - maxBytes, 0);
  const byteCapped = windowStart > 0;

  let readStart = windowStart;
  let hasOlder = byteCapped;
  if (byteCapped) {
    const probe = readChunk(fd, size, windowStart, beforeClamped - windowStart);
    const firstNewline = probe.indexOf(0x0a);
    if (firstNewline === -1) {
      // ウィンドウ全体が改行を含まない（1行が maxBytes を超える異常系）。行境界を確定できないため、
      // このウィンドウは読み取り不能として扱い hasOlder を false にする（無限ループ防止。
      // フォールバック合成はせず、単に「これ以上遡れない」という事実を返す）。
      readStart = beforeClamped;
      hasOlder = false;
    } else {
      readStart = windowStart + firstNewline + 1;
    }
  }

  const buf = readChunk(fd, size, readStart, beforeClamped - readStart);
  const entries: T[] = [];
  for (const line of buf.toString('utf-8').split('\n')) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }

  return { entries, prevOffset: readStart, hasOlder };
}
