import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

const READ_CHUNK_BYTES = 64 * 1024;
/** 1 回の tick で読む上限。超えた分は次のイベントループに回し、巨大なファイルで他の処理を止めない。 */
const MAX_BYTES_PER_TICK = 8 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface FileFollowerOptions {
  /** 追記された内容（UTF-8 として復号済み。文字がチャンク境界で割れても次の呼び出しに持ち越す）。 */
  onData: (text: string) => void;
  /** 開始後の読み取りエラー。出たら追跡は止まる。 */
  onError?: (err: Error) => void;
  pollIntervalMs?: number;
}

/**
 * `tail -f -n +1 <file>` の Node 実装。先頭から読み、追記を追う。
 * - ファイルは開始時に開いたままにする（`tail -f` と同じ descriptor 追跡。削除・リネームされても読み続ける）。
 *   開始時にファイルが無ければ `start()` が投げる（`tail -f` も存在しないファイルでは終了する）。
 * - サイズが読み取り位置より小さくなったら（切り詰め）、先頭から読み直す。
 * - 変更の検知は `fs.watch` とポーリングの併用（watch が使えない環境でもポーリングで追う）。
 * - `stop()` で watcher・タイマー・fd を解放する。以後は何も出さない。
 */
export class FileFollower {
  private fd: number | null = null;
  private offset = 0;
  private decoder = new StringDecoder('utf8');
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private stopped = false;

  constructor(private readonly filePath: string, private readonly options: FileFollowerOptions) {}

  start(): void {
    if (this.fd !== null || this.stopped) throw new Error('FileFollower: already started');
    this.fd = fs.openSync(this.filePath, 'r');
    try {
      this.watcher = fs.watch(this.filePath, () => this.poll());
      this.watcher.on('error', () => this.closeWatcher());
    } catch {
      // fs.watch が使えなくても、ポーリングだけで追える。
    }
    this.timer = setInterval(() => this.poll(), this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    this.closeWatcher();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
  }

  private closeWatcher(): void {
    if (!this.watcher) return;
    try { this.watcher.close(); } catch { /* already closed */ }
    this.watcher = null;
  }

  private poll(): void {
    if (this.stopped || this.fd === null || this.reading) return;
    this.reading = true;
    try {
      this.drain();
    } finally {
      this.reading = false;
    }
  }

  private drain(): void {
    let remaining = MAX_BYTES_PER_TICK;
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (remaining > 0 && !this.stopped) {
      const n = this.readNext(buf);
      if (n === 0) return;
      remaining -= n;
      const text = this.decoder.write(buf.subarray(0, n));
      if (text !== '' && !this.deliver(text)) return;
    }
    if (!this.stopped) setImmediate(() => this.poll());
  }

  /** onData の例外は、タイマーや watch の中では処理されない例外になるので、ここで捕まえて追跡を止め onError に渡す。 */
  private deliver(text: string): boolean {
    try {
      this.options.onData(text);
      return true;
    } catch (err) {
      this.stop();
      this.options.onError?.(err as Error);
      return false;
    }
  }

  /** 読めたバイト数。EOF なら 0。読み取りに失敗したら追跡を止めて onError に渡し、0 を返す。 */
  private readNext(buf: Buffer): number {
    if (this.fd === null) return 0;
    try {
      this.resetOnTruncation(this.fd);
      const n = fs.readSync(this.fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      return n;
    } catch (err) {
      this.stop();
      this.options.onError?.(err as Error);
      return 0;
    }
  }

  private resetOnTruncation(fd: number): void {
    if (fs.fstatSync(fd).size < this.offset) {
      this.offset = 0;
      this.decoder = new StringDecoder('utf8');
    }
  }
}
