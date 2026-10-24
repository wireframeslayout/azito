import * as fs from 'fs';
import { hostPathFor, type HostPathApi } from '@azito/shared';
import { pathRulesOf } from '../../../shared/os/hostEnv';

/** ハブが pane の出力を追跡させるために作らせるファイル名（`azito-pipe-<paneId>-<stamp>.log`）。 */
const STREAM_FILE_NAME = /^azito-pipe-[A-Za-z0-9_-]+\.log$/;
const DEFAULT_MAX_FILES = 1024;
/**
 * WS の接続が無い状態がこの時間続いた登録は、所有者（ハブ）がいなくなったとみなして外す。
 * ハブ（AgentPaneStream）は登録が通らない・切れている間、最大 11 回試す: 待ちは 1+2+4+8+16+30×5 = 181 秒、
 * 各回の HTTP の待ちは最大 20 秒（15 秒の期限 + 5 秒の余裕）で 220 秒、合わせて約 401 秒。それより長い 10 分にして、
 * ハブがまだ再試行している間の登録を回収しないようにする。
 */
const DEFAULT_LEASE_MS = 10 * 60_000;

/** ハブが登録を要求したパスが、管理対象にできない形だった。 */
export class InvalidStreamFileError extends Error {}

interface Entry {
  /** 登録または最後の WS 切断の時刻。接続が無いまま leaseMs を過ぎると回収される。 */
  idleSince: number;
  connections: number;
}

export interface ManagedStreamFilesOptions {
  logger?: { warn(msg: string): void };
  maxFiles?: number;
  leaseMs?: number;
  now?: () => number;
}

const flag = (name: 'O_NOFOLLOW' | 'O_NONBLOCK'): number => fs.constants[name] ?? 0;

/**
 * このプロセスが管理しているストリームファイル。`fileTailHandler`（`/ws?mode=file-tail`）は、ここに登録されたファイルしか
 * 追跡しない（接頭辞だけで通すと、同じ一時フォルダにある同名規則の他者のファイルも読めてしまう）。
 * 登録はハブ（`AgentPaneStream`）が `POST /api/pane-streams` で行い、解除（`DELETE`）でファイルも消す。
 * 登録はメモリ上だけなので、エージェントが再起動すると消える。ハブは再接続のたびに登録し直す。
 *
 * 解除が届かなかった登録（ハブのクラッシュなど）は、リースで回収する: WS の接続が無い状態が `leaseMs` 続いたら、
 * 次の登録のときにファイルごと外す。上限に達したら、期限切れ、ファイルが消えたもの、の順に外し、それでも空かなければ（猶予中の登録は守る）新しい登録を拒否してログに出す。
 */
export class ManagedStreamFiles {
  private readonly files = new Map<string, Entry>();
  private readonly maxFiles: number;
  private readonly leaseMs: number;
  private readonly now: () => number;

  private readonly hostPath: HostPathApi;

  /** `platform` はこのプロセスのホストの OS（パスの規則）。`allowedDirs` は、管理対象のファイルを置いてよい一時フォルダ（そのホストの絶対パス）。 */
  constructor(platform: NodeJS.Platform, private readonly allowedDirs: readonly string[], private readonly options: ManagedStreamFilesOptions = {}) {
    this.hostPath = hostPathFor(pathRulesOf(platform));
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? Date.now;
  }

  /** 検証してファイルを作り（既存の通常ファイルなら中身は触らない）、管理対象に加える。何度呼んでも同じ。 */
  register(filePath: string): void {
    this.assertManageable(filePath);
    const known = this.files.get(filePath);
    if (!known) this.makeRoom();
    this.ensureRegularFile(filePath);
    if (known) known.idleSince = this.now();
    else this.files.set(filePath, { idleSince: this.now(), connections: 0 });
  }

  isManaged(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /** WS の接続が始まった。返す関数を切断時に呼ぶと、リースの時計が再び動く。 */
  attach(filePath: string): () => void {
    const entry = this.files.get(filePath);
    if (!entry) return () => {};
    entry.connections++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.connections--;
      entry.idleSince = this.now();
    };
  }

  /** 管理対象から外し、ファイルを消す。登録されていないパスは何もしない（他のファイルを消さない）。 */
  unregister(filePath: string): void {
    if (!this.files.delete(filePath)) return;
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }

  /** 新しい登録のために空きを作る。 */
  private makeRoom(): void {
    const now = this.now();
    for (const [file, entry] of this.files) {
      if (entry.connections === 0 && now - entry.idleSince > this.leaseMs) this.unregister(file);
    }
    if (this.files.size < this.maxFiles) return;

    for (const file of [...this.files.keys()]) {
      if (!fs.existsSync(file)) this.files.delete(file);
    }
    if (this.files.size < this.maxFiles) return;

    // 猶予（リース）の中にある登録は、接続が無くても守る（切断直後のハブがまだ再接続を試している）。空きが作れないなら拒否する。
    this.options.logger?.warn(`[pane-streams] refusing a registration: ${this.files.size} files, none past its lease or missing`);
    throw new InvalidStreamFileError('Too many managed stream files');
  }

  /**
   * 通常ファイルが無ければ排他的に作る。あれば（再登録）中身を触らずに開き、通常ファイルで自分のものであることを確かめる。
   * FIFO で open が止まらないよう O_NONBLOCK で開き、symlink は辿らない。
   */
  private ensureRegularFile(filePath: string): void {
    let fd: number;
    try {
      fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flag('O_NOFOLLOW'), 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw this.refuse(err);
      try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | flag('O_NONBLOCK') | flag('O_NOFOLLOW'));
      } catch (openErr) {
        throw this.refuse(openErr);
      }
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new InvalidStreamFileError('Stream file path exists and is not a regular file');
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== uid) throw new InvalidStreamFileError('Stream file path exists and belongs to another user');
    } finally {
      fs.closeSync(fd);
    }
  }

  private refuse(err: unknown): InvalidStreamFileError {
    return new InvalidStreamFileError(`Stream file cannot be opened: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }

  private assertManageable(filePath: string): void {
    if (!this.hostPath.isAbsolute(filePath) || this.hostPath.normalize(filePath) !== filePath) {
      throw new InvalidStreamFileError('Stream file path must be a normalized absolute path');
    }
    const dir = this.hostPath.dirname(filePath);
    if (!this.allowedDirs.some((allowed) => this.hostPath.samePath(allowed, dir)) || !STREAM_FILE_NAME.test(this.hostPath.basename(filePath))) {
      throw new InvalidStreamFileError('Stream file path is not an azito pipe file in a temp directory');
    }
  }
}
