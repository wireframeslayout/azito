import fs from 'fs';

// ─── JSONL のバイト窓読み（純粋関数群） ───
//
// 旧 TranscriptService の初回読み・差分読み・行境界処理をエージェント非依存の形で切り出したもの。
// 「1行 → エントリ」の変換だけは呼び出し側の parseLine に委譲する。

export interface WindowReadResult<T> {
  entries: T[];
  nextOffset: number;
  truncated: boolean;
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
 * 初回読み: ファイル末尾から最大 maxBytes バイトだけ位置指定で読む。
 * バイト数制限で頭を切った場合はその範囲内の最初の完全行から処理し、末尾の未完結行は消費しない
 * （差分読みと同じ規則: nextOffset = 最後の改行位置+1）。
 * tailLimit を超えるエントリ数は末尾側だけ残す（truncated に反映）。
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
  if (consumedLength > 0) {
    const consumed = buf.subarray(0, consumedLength).toString('utf-8');
    for (const line of consumed.split('\n')) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
  }

  const nextOffset = lastNewline === -1 ? readStart : readStart + lastNewline + 1;
  const tailEntries = entries.slice(-tailLimit);
  const entryTruncated = tailEntries.length < entries.length;

  return {
    entries: tailEntries,
    nextOffset,
    truncated: byteCapped || entryTruncated,
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
    return { entries: [], nextOffset: start, truncated: false };
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
  };
}
