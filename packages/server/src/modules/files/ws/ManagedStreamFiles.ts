import * as fs from 'fs';
import * as path from 'path';

/** ハブが pane の出力を追跡させるために作らせるファイル名（`azito-pipe-<paneId>-<stamp>.log`）。 */
const STREAM_FILE_NAME = /^azito-pipe-[A-Za-z0-9_-]+\.log$/;
const MAX_MANAGED_FILES = 1024;

/** ハブが登録を要求したパスが、管理対象にできない形だった。 */
export class InvalidStreamFileError extends Error {}

/**
 * このプロセスが管理しているストリームファイル。`fileTailHandler`（`/ws?mode=file-tail`）は、ここに登録されたファイルしか
 * 追跡しない（接頭辞だけで通すと、同じ一時フォルダにある同名規則の他者のファイルも読めてしまう）。
 * 登録はハブ（`AgentPaneStream`）が `POST /api/pane-streams` で行い、解除（`DELETE`）でファイルも消す。
 * 登録はメモリ上だけなので、エージェントが再起動すると消える。ハブは再接続のたびに登録し直す。
 */
export class ManagedStreamFiles {
  private readonly files = new Set<string>();

  /** `allowedDirs` は、管理対象のファイルを置いてよい一時フォルダ（絶対パス）。 */
  constructor(private readonly allowedDirs: readonly string[]) {}

  /** 検証してファイルを作り（既存なら中身は触らない）、管理対象に加える。何度呼んでも同じ。 */
  register(filePath: string): void {
    this.assertManageable(filePath);
    if (!this.files.has(filePath) && this.files.size >= MAX_MANAGED_FILES) {
      throw new InvalidStreamFileError('Too many managed stream files');
    }
    // 追記モードで開く（truncate しない）。symlink は辿らない（共有の一時フォルダに置かれた別物を読み書きしないため）。
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);
    fs.closeSync(fs.openSync(filePath, flags, 0o600));
    this.files.add(filePath);
  }

  isManaged(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /** 管理対象から外し、ファイルを消す。登録されていないパスは何もしない（他のファイルを消さない）。 */
  unregister(filePath: string): void {
    if (!this.files.delete(filePath)) return;
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }

  private assertManageable(filePath: string): void {
    if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
      throw new InvalidStreamFileError('Stream file path must be a normalized absolute path');
    }
    if (!this.allowedDirs.includes(path.dirname(filePath)) || !STREAM_FILE_NAME.test(path.basename(filePath))) {
      throw new InvalidStreamFileError('Stream file path is not an azito pipe file in a temp directory');
    }
  }
}
