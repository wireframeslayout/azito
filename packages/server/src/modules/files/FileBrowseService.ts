import * as path from 'path';
import { createHash } from 'crypto';
import type { ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';
import { shellQuote } from '../../shared/shellQuote';

const sq = shellQuote;

/** Content-hash optimistic lock: sha256 of file text, hex-encoded. Shared by the read side
 * (getFileContent, hashing the fetched content) and the write side (writeFileContentLocked,
 * hashing the current on-disk/remote content before replacing it) so both sides compare the same
 * bytes the same way. */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ─── File type lookup tables ───

export const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.json': 'json', '.css': 'css', '.html': 'html',
  '.md': 'markdown', '.py': 'python',
  '.sh': 'shell', '.bash': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.sql': 'sql', '.toml': 'toml',
};

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};

export const BINARY_EXTS = new Set([
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.wasm', '.class', '.pyc',
]);

export const MAX_FILE_SIZE = 500 * 1024; // 500 KB
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
// リモート書き込みの base64 チャンク長。コマンド全体が Linux の
// MAX_ARG_STRLEN(131072) を確実に下回るよう余裕を持たせる
export const WRITE_CHUNK_SIZE = 48 * 1024;
export const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
  '.json': 'application/json', '.xml': 'application/xml',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.avi': 'video/x-msvideo',
  '.wasm': 'application/wasm',
  '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.sh': 'text/x-shellscript', '.py': 'text/x-python',
  '.sql': 'text/plain', '.toml': 'text/plain',
};

// ─── Errors ───

/** Service-level error carrying the HTTP status the route should respond with. */
export class FileBrowseError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

// ─── Result types ───

export type FileEntry = {
  name: string;
  type: 'directory' | 'file';
  path: string;
  size?: number;
};

export type FileContentResult =
  | { type: 'image'; mimeType: string; base64: string; path: string; size: number }
  | { type: 'pdf'; mimeType: 'application/pdf'; base64: string; path: string; size: number }
  | { content: string; path: string; size: number; language: string; mtime: number; hash: string };

export interface FileDownloadResult {
  buffer: Buffer;
  contentType: string;
  basename: string;
}

// ─── Service ───

export class FileBrowseService {
  constructor(private readonly tmux: TmuxClient) {}

  // Per (serverName, path) in-process write serialization (simple mutex via Promise chaining). The hub
  // is a single process, so this is sufficient to close the race where two concurrent saves against the
  // same file both read the same baseMtime, both pass the conflict check, and the second silently
  // clobbers the first ("last write wins" — mtime check and replace are separate operations with an
  // await gap between them, especially on the remote path). Keyed by server name + path so unrelated
  // files/servers never block each other. Entries are removed once their chain settles so the map does
  // not grow unbounded.
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  private async withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.writeLocks.get(key) ?? Promise.resolve();
    // Swallow the prior run's rejection here (not propagated) so one failed save doesn't poison the
    // chain for the next caller waiting on the same key — each caller still observes its own fn()'s
    // outcome via the returned/awaited `run` below.
    const run = prior.catch(() => {}).then(fn);
    this.writeLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.writeLocks.get(key) === run) {
        this.writeLocks.delete(key);
      }
    }
  }

  /** GET /api/servers/:name/directories 用: 部分パスに対する候補ディレクトリ一覧 */
  async listDirectories(srv: ServerConfig, inputPath: string): Promise<string[]> {
    try {
      let entries: string[] = [];

      if (srv.type === 'local') {
        const fs = await import('fs');
        const path = await import('path');

        let dir: string;
        let prefix: string;

        if (inputPath.endsWith('/')) {
          dir = inputPath;
          prefix = '';
        } else {
          dir = path.dirname(inputPath);
          prefix = path.basename(inputPath).toLowerCase();
        }

        try {
          const items = fs.readdirSync(dir, { withFileTypes: true });
          entries = items
            .filter(item => item.isDirectory())
            .filter(item => !item.name.startsWith('.'))
            .filter(item => !prefix || item.name.toLowerCase().startsWith(prefix))
            .map(item => path.join(dir, item.name))
            .slice(0, 20);
        } catch { /* dir doesn't exist */ }
      } else {
        // Remote: use find to avoid alias/icon contamination from ls
        let dir: string;
        let prefix: string;
        if (inputPath.endsWith('/')) {
          dir = inputPath;
          prefix = '';
        } else {
          const lastSlash = inputPath.lastIndexOf('/');
          dir = inputPath.substring(0, lastSlash + 1) || '/';
          prefix = inputPath.substring(lastSlash + 1).toLowerCase();
        }
        const cmd = `LC_ALL=C command find ${sq(dir)} -maxdepth 1 -mindepth 1 -type d -printf '%f\\n' 2>/dev/null | head -20`;
        try {
          const result = await this.tmux.execCommand(srv, cmd);
          entries = stripTerminalArtifacts(result.stdout).trim().split('\n').filter(Boolean)
            .map(name => name.trim())
            .filter(name => !name.startsWith('.'))
            .filter(name => !prefix || name.toLowerCase().startsWith(prefix))
            .map(name => dir + name)
            .slice(0, 20);
        } catch { /* ignore */ }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /** GET /api/servers/:name/files 用: ディレクトリ内エントリ一覧 */
  async listFiles(srv: ServerConfig, dirPath: string, showHidden: boolean): Promise<FileEntry[]> {
    if (srv.type === 'local') {
      const fs = await import('fs');
      const path = await import('path');
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      const entries: FileEntry[] = items
        .filter((item) => showHidden || !item.name.startsWith('.'))
        .map((item) => {
          const fullPath = path.join(dirPath, item.name);
          const isDir = item.isDirectory();
          const entry: FileEntry = {
            name: item.name,
            type: isDir ? 'directory' : 'file',
            path: fullPath,
          };
          if (!isDir) {
            try { entry.size = fs.statSync(fullPath).size; } catch { /* ignore */ }
          }
          return entry;
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return entries;
    }

    // Remote: use find to avoid alias/icon contamination from ls
    const hiddenFilter = showHidden ? '' : " ! -name '.*'";
    const cmd = `LC_ALL=C command find ${sq(dirPath)} -maxdepth 1 -mindepth 1${hiddenFilter} -printf '%y %s %f\\n' 2>/dev/null | sort`;
    const result = await this.tmux.execCommand(srv, cmd);
    const lines = stripTerminalArtifacts(result.stdout).trim().split('\n').filter(Boolean);
    const entries: FileEntry[] = [];
    for (const line of lines) {
      const match = line.match(/^(\S)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, typeChar, sizeStr, name] = match;
      if (name === '.' || name === '..') continue;
      const isDir = typeChar === 'd';
      const entry: FileEntry = {
        name,
        type: isDir ? 'directory' : 'file',
        path: dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name,
      };
      if (!isDir) entry.size = parseInt(sizeStr, 10) || 0;
      entries.push(entry);
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  /** GET /api/servers/:name/files/content 用: ファイル内容（画像/PDF/テキスト） */
  async getFileContent(srv: ServerConfig, filePath: string): Promise<FileContentResult> {
    const pathMod = await import('path');
    const ext = pathMod.extname(filePath).toLowerCase();

    // ── Image file preview ──
    if (IMAGE_EXTS.has(ext)) {
      const mimeType = IMAGE_MIME[ext] || 'application/octet-stream';
      if (srv.type === 'local') {
        const fs = await import('fs');
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new FileBrowseError('Not a regular file', 400);
        if (stat.size > MAX_IMAGE_SIZE) {
          throw new FileBrowseError(`Image too large (${Math.round(stat.size / 1024)}KB). Maximum is 5MB.`, 400);
        }
        const buf = fs.readFileSync(filePath);
        return { type: 'image', mimeType, base64: buf.toString('base64'), path: filePath, size: stat.size };
      } else {
        const typeCheck = await this.tmux.execCommand(srv, `test -f ${sq(filePath)} && echo ok || echo ng`);
        if (typeCheck.stdout.trim() !== 'ok') throw new FileBrowseError('Not a regular file', 400);
        const sizeResult = await this.tmux.execCommand(srv, `stat -c%s ${sq(filePath)} 2>/dev/null || stat -f%z ${sq(filePath)} 2>/dev/null`);
        const size = parseInt(sizeResult.stdout.trim(), 10) || 0;
        if (size > MAX_IMAGE_SIZE) {
          throw new FileBrowseError(`Image too large (${Math.round(size / 1024)}KB). Maximum is 5MB.`, 400);
        }
        const result = await this.tmux.execCommand(srv, `base64 -w0 ${sq(filePath)} 2>/dev/null || base64 ${sq(filePath)} 2>/dev/null`);
        const base64 = result.stdout.replace(/[\r\n]/g, '');
        return { type: 'image', mimeType, base64, path: filePath, size };
      }
    }

    // ── PDF file preview ──
    if (ext === '.pdf') {
      if (srv.type === 'local') {
        const fs = await import('fs');
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new FileBrowseError('Not a regular file', 400);
        if (stat.size > MAX_IMAGE_SIZE) {
          throw new FileBrowseError(`PDF too large (${Math.round(stat.size / 1024)}KB). Maximum is 5MB.`, 400);
        }
        const buf = fs.readFileSync(filePath);
        return { type: 'pdf', mimeType: 'application/pdf', base64: buf.toString('base64'), path: filePath, size: stat.size };
      } else {
        const typeCheck = await this.tmux.execCommand(srv, `test -f ${sq(filePath)} && echo ok || echo ng`);
        if (typeCheck.stdout.trim() !== 'ok') throw new FileBrowseError('Not a regular file', 400);
        const sizeResult = await this.tmux.execCommand(srv, `stat -c%s ${sq(filePath)} 2>/dev/null || stat -f%z ${sq(filePath)} 2>/dev/null`);
        const size = parseInt(sizeResult.stdout.trim(), 10) || 0;
        if (size > MAX_IMAGE_SIZE) {
          throw new FileBrowseError(`PDF too large (${Math.round(size / 1024)}KB). Maximum is 5MB.`, 400);
        }
        const result = await this.tmux.execCommand(srv, `base64 -w0 ${sq(filePath)} 2>/dev/null || base64 ${sq(filePath)} 2>/dev/null`);
        const base64 = result.stdout.replace(/[\r\n]/g, '');
        return { type: 'pdf', mimeType: 'application/pdf', base64, path: filePath, size };
      }
    }

    if (BINARY_EXTS.has(ext)) {
      throw new FileBrowseError('Binary file cannot be displayed', 400);
    }

    const language = EXT_LANG[ext] || 'text';

    if (srv.type === 'local') {
      const fs = await import('fs');
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new FileBrowseError('Not a regular file', 400);
      if (stat.size > MAX_FILE_SIZE) {
        throw new FileBrowseError(`File too large (${Math.round(stat.size / 1024)}KB). Maximum is 500KB.`, 400);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      // Check for null bytes (binary)
      if (content.includes('\0')) {
        throw new FileBrowseError('Binary file cannot be displayed', 400);
      }
      const hash = sha256Hex(content);
      return { content, path: filePath, size: stat.size, language, mtime: stat.mtimeMs, hash };
    } else {
      // Remote: reject non-regular files, then check size, then cat
      const typeCheck = await this.tmux.execCommand(srv, `test -f ${sq(filePath)} && echo ok || echo ng`);
      if (typeCheck.stdout.trim() !== 'ok') throw new FileBrowseError('Not a regular file', 400);
      const sizeResult = await this.tmux.execCommand(srv, `stat -c%s ${sq(filePath)} 2>/dev/null || stat -f%z ${sq(filePath)} 2>/dev/null`);
      const size = parseInt(sizeResult.stdout.trim(), 10) || 0;
      if (size > MAX_FILE_SIZE) {
        throw new FileBrowseError(`File too large (${Math.round(size / 1024)}KB). Maximum is 500KB.`, 400);
      }
      const result = await this.tmux.execCommand(srv, `cat -- ${sq(filePath)}`);
      const content = result.stdout;
      if (content.includes('\0')) {
        throw new FileBrowseError('Binary file cannot be displayed', 400);
      }
      const mtimeResult = await this.getRemoteMtimeMs(srv, filePath);
      // Computed from the already-fetched `content` on the Node side — no extra remote round-trip.
      // This is the read-side counterpart to writeFileContentLocked's `sha256sum`/`shasum` verification
      // below; both hash the same bytes, so an unrelated external edit landing in the same second as
      // this save (past the mtime check's whole-second precision on non-GNU `stat`) is still caught.
      const hash = sha256Hex(content);
      return { content, path: filePath, size, language, mtime: mtimeResult?.mtimeMs ?? 0, hash };
    }
  }

  /**
   * Fetches a remote file's mtime. Prefers GNU `stat`'s `%.Y` (sub-second
   * precision, e.g. `1750000000.123456789`) so callers can compare mtimes
   * almost exactly instead of only to the nearest second; falls back to
   * whole-second `%Y` (older/non-GNU `stat`) and finally to BSD/macOS `stat
   * -f%m` (whole seconds only — that binary has no sub-second `%.m`
   * equivalent). `precise` reports which precision was actually obtained
   * (`raw` contains a `.`) so callers pick an appropriate comparison
   * tolerance themselves, rather than this method guessing precision back
   * out of the numeric value (a whole-second-but-coincidentally-precise
   * mtime would be indistinguishable from an imprecise one that way).
   * Returns `null` when the value cannot be parsed (e.g. the file
   * disappeared between the caller's earlier check and this call) so the
   * caller decides how to fail, rather than silently returning `0` (which
   * would read as "epoch", not "unknown").
   *
   * Every fragment is quoted via `sq()` (`shellQuote`) — building this
   * command with `"${filePath}"` (bare double-quote interpolation) lets a
   * filePath containing `$(...)` execute as a subshell (Issue #27-class
   * command injection).
   */
  private async getRemoteMtimeMs(srv: ServerConfig, filePath: string): Promise<{ mtimeMs: number; precise: boolean } | null> {
    const q = sq(filePath);
    const result = await this.tmux.execCommand(
      srv,
      `stat -c%.Y ${q} 2>/dev/null || stat -c%Y ${q} 2>/dev/null || stat -f%m ${q} 2>/dev/null`,
    );
    const raw = stripTerminalArtifacts(result.stdout).trim();
    if (!raw) return null;
    const seconds = parseFloat(raw);
    if (isNaN(seconds)) return null;
    return { mtimeMs: seconds * 1000, precise: raw.includes('.') };
  }

  /**
   * Fetches a remote file's permission mode as an octal string (e.g. `755`),
   * for preserving it across the decode-to-tempfile + `mv` replace in
   * `writeFileContent`. GNU `stat -c%a` first, BSD/macOS `stat -f%Lp`
   * fallback. Returns `null` when the file does not exist yet (new file —
   * the tempfile's default mode is fine) or the mode cannot be parsed as
   * octal digits (defensive: never feed unvalidated stdout into `chmod`).
   */
  private async getRemoteFileMode(srv: ServerConfig, filePath: string): Promise<string | null> {
    const q = sq(filePath);
    const result = await this.tmux.execCommand(
      srv,
      `stat -c%a ${q} 2>/dev/null || stat -f%Lp ${q} 2>/dev/null`,
    );
    const raw = stripTerminalArtifacts(result.stdout).trim();
    if (!/^[0-7]{3,4}$/.test(raw)) return null;
    return raw;
  }

  /**
   * Tolerance for comparing a caller-supplied `baseMtime` (ms) against a
   * freshly-fetched remote mtime. `precise` (sub-second `stat -c%.Y` output)
   * gets a 1ms epsilon that only absorbs float rounding from the
   * `parseFloat(...) * 1000` conversion above. Whole-second-only output
   * (`%Y` or the BSD `-f%m` fallback — the environment has no sub-second
   * `stat`) genuinely cannot distinguish two edits within the same second,
   * so a wider ~1s tolerance is unavoidable there; this is a real precision
   * gap on those hosts, not a deliberately loose check, and is scoped to
   * remote hosts lacking GNU `stat` (local writes below compare
   * `fs.statSync(...).mtimeMs` exactly).
   */
  private remoteMtimeTolerance(precise: boolean): number {
    return precise ? 1 : 999;
  }

  /**
   * Fetches a remote file's content sha256 (hex), preferring GNU/coreutils `sha256sum` and falling
   * back to BSD/macOS `shasum -a 256` (both print `<hash>  <path>`, so only the first
   * whitespace-delimited field is kept). Returns `null` when neither tool is present or the file
   * disappeared — the caller treats that as "hash verification unavailable" and falls back to the
   * mtime check alone (never as "hash matches"), logging once so the gap is visible rather than
   * silently accepted.
   */
  private async getRemoteSha256(srv: ServerConfig, filePath: string): Promise<string | null> {
    const q = sq(filePath);
    const result = await this.tmux.execCommand(
      srv,
      `sha256sum ${q} 2>/dev/null || shasum -a 256 ${q} 2>/dev/null`,
    );
    const raw = stripTerminalArtifacts(result.stdout).trim();
    const hash = raw.split(/\s+/, 1)[0];
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    return hash;
  }

  async writeFileContent(
    srv: ServerConfig,
    filePath: string,
    content: string,
    baseMtime?: number,
    baseHash?: string,
  ): Promise<{ mtime: number; hash: string }> {
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
      throw new FileBrowseError(`Content too large. Maximum is 500KB.`, 400);
    }
    // Serialize the mtime-check-then-replace sequence per (server, path) so two concurrent saves
    // against the same baseMtime can't both pass the conflict check — see withWriteLock above.
    return this.withWriteLock(
      `${srv.name}:${filePath}`,
      () => this.writeFileContentLocked(srv, filePath, content, baseMtime, baseHash),
    );
  }

  private async writeFileContentLocked(
    srv: ServerConfig,
    filePath: string,
    content: string,
    baseMtime?: number,
    baseHash?: string,
  ): Promise<{ mtime: number; hash: string }> {
    if (srv.type === 'local') {
      const fs = await import('fs');
      if (baseMtime != null) {
        const stat = fs.statSync(filePath);
        // ミリ秒精度の厳密一致。以前の `Math.abs(...) > 1000` は同一秒内の
        // 外部編集を黙って上書きしてしまっていた（Issue #27 review Important 3）。
        // baseMtime はこのプロセス自身が以前返した mtimeMs をそのまま JSON
        // 往復させたものなので、丸め誤差なく厳密比較できる。
        if (stat.mtimeMs !== baseMtime) {
          throw new FileBrowseError(
            JSON.stringify({ conflict: true, currentMtime: stat.mtimeMs }),
            409,
          );
        }
      }
      // Content-hash optimistic lock (Issue #27 review Important 3): the mtime check above is
      // exact locally (Node's `mtimeMs` has sub-millisecond-comparable precision), so this is mostly
      // a defense-in-depth pairing with the remote branch below where mtime precision can be
      // second-only. Verified right before the replace (mutex is already held via withWriteLock, so
      // no other save from this process can land between this read and the write below).
      if (baseHash != null) {
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        if (sha256Hex(currentContent) !== baseHash) {
          throw new FileBrowseError(
            JSON.stringify({ conflict: true, currentMtime: fs.statSync(filePath).mtimeMs }),
            409,
          );
        }
      }
      // symlink 追従を避けるため O_NOFOLLOW で開く。呼び出し元（routes.ts の
      // PUT /files/content）は保存対象が既に存在する場合、書き込み前に
      // FileBrowseService.resolveExistingTargetRealPath() で実体パスを解決・
      // 封じ込め検証した上でその実体パスをここへ渡す。O_NOFOLLOW はその
      // 検証と実際の書き込みの間（TOCTOU）に symlink が差し替えられた場合の
      // 保険であり、検証自体の代わりではない。ファイルが未存在なら新規作成
      // されるだけで symlink 追従の余地はない。
      const O = fs.constants;
      let fd: number;
      try {
        fd = fs.openSync(filePath, O.O_WRONLY | O.O_CREAT | O.O_TRUNC | O.O_NOFOLLOW, 0o644);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') {
          throw new FileBrowseError('Refusing to write through a symlink', 400);
        }
        throw err;
      }
      try {
        fs.writeSync(fd, content, null, 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
      const newStat = fs.statSync(filePath);
      return { mtime: newStat.mtimeMs, hash: sha256Hex(content) };
    } else {
      const q = sq(filePath);
      if (baseMtime != null) {
        const current = await this.getRemoteMtimeMs(srv, filePath);
        // current が取れない場合（stat の一時失敗やファイル消失）は「衝突なし」
        // とみなさず fail closed する。バイパスは呼び出し元が force 指定時に
        // baseMtime 自体を渡さない経路（routes.ts）でのみ行う。
        if (current == null) {
          throw new FileBrowseError(
            JSON.stringify({ conflict: true, currentMtime: null }),
            409,
          );
        }
        if (Math.abs(current.mtimeMs - baseMtime) > this.remoteMtimeTolerance(current.precise)) {
          throw new FileBrowseError(
            JSON.stringify({ conflict: true, currentMtime: current.mtimeMs }),
            409,
          );
        }
      }
      // Content-hash optimistic lock (Issue #27 review Important 3): on hosts whose `stat` has only
      // whole-second precision (the BSD/macOS `-f%m` fallback in getRemoteMtimeMs), the mtime check
      // above cannot distinguish an external edit that landed within the same second as the read this
      // save is based on — the write would silently clobber it. sha256sum/shasum catches that because
      // it compares actual bytes rather than a coarse timestamp. When neither tool is available,
      // getRemoteSha256 returns null; that is "verification unavailable", not "hashes match" — the
      // save proceeds on the mtime check alone (already run above) and this gap is logged so it's
      // visible in server logs rather than silently accepted.
      if (baseHash != null) {
        const currentHash = await this.getRemoteSha256(srv, filePath);
        if (currentHash == null) {
          // eslint-disable-next-line no-console
          console.warn(`[FileBrowseService] sha256sum/shasum unavailable on ${srv.name}; falling back to mtime-only conflict detection for ${filePath}`);
        } else if (currentHash !== baseHash) {
          const current = await this.getRemoteMtimeMs(srv, filePath);
          throw new FileBrowseError(
            JSON.stringify({ conflict: true, currentMtime: current?.mtimeMs ?? null }),
            409,
          );
        }
      }
      // agent/ssh の exec は base64 全文を1コマンド引数に載せると Linux の
      // MAX_ARG_STRLEN(≒128KB) を超えて spawn E2BIG になるため、チャンク分割で
      // 一時ファイルに追記してからデコードする。一時ファイル名にリクエストごとの
      // 乱数サフィックスを入れるのは、固定名だと同一ファイルへの並行保存が
      // 互いの一時ファイルを踏みつけて破損し得るため（Issue #27 review Important 2）。
      // 既存ファイルのパーミッション（例: 0755）を保全する。デコード先の一時
      // ファイルは touch/リダイレクトで作られるため既定 umask 適用の 0644 になり、
      // 何もせず mv すると実行ビット等が消える。新規ファイルの場合は mode が
      // 取れない（null）ので一時ファイルの既定モードのままで良い。
      const existingMode = await this.getRemoteFileMode(srv, filePath);
      const { randomBytes } = await import('crypto');
      const nonce = randomBytes(8).toString('hex');
      const uploadTmp = `${filePath}.azito-upload-${nonce}`;
      const decodedTmp = `${filePath}.azito-decoded-${nonce}`;
      const qUpload = sq(uploadTmp);
      const qDecoded = sq(decodedTmp);
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      // `umask 077` on the creation command means the staging file is created 0600 (owner-only) from
      // the instant it exists, instead of the default-umask 0644 window an attacker on a shared host
      // could read the (base64-encoded, but still plaintext-recoverable) content through before the
      // final decode step ever runs (Issue #27 review follow-up: umask/cleanup on remote temp files).
      // Each exec runs `/bin/sh -c <command>` as its own process (AgentTransport -> agent routes.ts
      // execFile), so this umask never leaks into unrelated commands.
      await this.tmux.execCommand(srv, `umask 077; : > ${qUpload}`);
      try {
        for (let i = 0; i < b64.length; i += WRITE_CHUNK_SIZE) {
          const chunk = b64.slice(i, i + WRITE_CHUNK_SIZE);
          await this.tmux.execCommand(srv, `printf '%s' ${sq(chunk)} >> ${qUpload}`);
        }
        // デコードを別の一時ファイルへ行ってから `mv` で原子的に置き換える
        // （デコード先を直接 filePath にすると、書き込み途中で読まれたり途中で
        // 失敗した場合に壊れた内容が残る）。既存ファイルのモードが分かっていれば
        // mv 前に一時ファイルへ chmod してからモードごと置き換える。成功時のみ
        // 明示的なマーカー `AZITO_WRITE_OK` を出力させ、それを見て初めて成功と
        // 判定する — SSH transport は常に exit code 0 を返すため
        // （RemoteWorktreeService の hasGitError と同じ既知事情）、code ではなく
        // stdout のマーカーで判定する（Issue #27 review Important 1: デコード
        // 失敗が握りつぶされ、直後の stat が旧ファイルで成功して見かけ上成功応答
        // になっていた）。
        //
        // Before trusting the staged file, verify its byte count against the base64 length we intended
        // to write. Each chunk append is its own exec/process; if one of them silently drops or
        // truncates bytes (e.g. a transient transport hiccup that still returns as "succeeded"), the
        // previous version of this command would decode+mv whatever partial content landed, as long as
        // it happened to still be valid base64 — truncating the file while reporting success (Issue #27
        // review follow-up: chunk append result was never checked against expected size). `wc -c`
        // against the known-correct `b64.length` catches that before any decode/replace happens.
        const chmodStep = existingMode != null ? ` && chmod ${sq(existingMode)} ${qDecoded}` : '';
        const expectedB64Len = b64.length;
        // `trap ... EXIT` (rather than a trailing `; rm -f ...`) cleans up the staging files on every
        // exit path of this script — including inside the `if`/`else` branches below — instead of only
        // the happy path a bare trailing command would cover.
        //
        // The cleanup command is built first and then quoted as a single unit via sq() (rather than
        // interpolating the already-quoted qUpload/qDecoded inside a hand-written outer single-quoted
        // string) — nesting single-quoted tokens inside another single-quoted literal does not nest in
        // POSIX shell; it closes the outer quote early. A containment-passing path containing `;`, `'`,
        // or `#` would then have its trailing bytes evaluated as shell syntax at trap-eval time, letting
        // an attacker with write access to a permitted path run arbitrary remote commands.
        const cleanup = `rm -f ${qUpload} ${qDecoded}`;
        const writeCmd =
          `umask 077; trap ${sq(cleanup)} EXIT; ` +
          `u=$(wc -c < ${qUpload} | tr -d ' '); ` +
          `if [ "$u" = ${expectedB64Len} ]; then ` +
          `base64 -d < ${qUpload} > ${qDecoded}${chmodStep} && mv -f ${qDecoded} ${q} && echo AZITO_WRITE_OK; ` +
          `else echo AZITO_WRITE_SIZE_MISMATCH; fi`;
        const writeResult = await this.tmux.execCommand(srv, writeCmd);
        const writeStdout = stripTerminalArtifacts(writeResult.stdout);
        if (writeStdout.includes('AZITO_WRITE_SIZE_MISMATCH')) {
          throw new FileBrowseError('Failed to write file: staged content size mismatch', 500);
        }
        if (!writeStdout.includes('AZITO_WRITE_OK')) {
          throw new FileBrowseError('Failed to write file', 500);
        }
      } catch (err) {
        // Best-effort cleanup for failures before the final command ran at all (e.g. a chunk append
        // exec throwing partway through the loop) — the final command's own `trap ... EXIT` only covers
        // failures within that single command, not an earlier one in this sequence.
        await this.tmux.execCommand(srv, `rm -f ${qUpload} ${qDecoded}`).catch(() => {});
        throw err;
      }
      const verifyResult = await this.getRemoteMtimeMs(srv, filePath);
      if (verifyResult == null) {
        throw new FileBrowseError('Failed to verify file write', 500);
      }
      return { mtime: verifyResult.mtimeMs, hash: sha256Hex(content) };
    }
  }

  /**
   * Resolves the real (symlink-free) path of `filePath` if it currently
   * exists, or returns `null` if it does not. Used by the PUT
   * files/content route so a save can be rejected — before any bytes are
   * written — when the target itself is a symlink pointing outside the
   * project's `workingDirectory` (Issue #27 review Critical 2: only the
   * parent directory was containment-checked, so a symlinked save target
   * could redirect the write anywhere on disk).
   *
   * Local uses `fs.realpath`, which resolves files as well as directories.
   * `PathContainment.ts`'s `RemotePathResolver` cannot be reused here for
   * the remote branch: it resolves via `cd -- <path> && pwd -P`, which only
   * works on directories (`cd` into a file fails) — see its own comments.
   * Remote resolution below is a small POSIX-portable shell loop instead:
   * it follows up to 20 levels of symlinks via `readlink` (no `-f`, since
   * BSD/macOS `readlink` lacks the GNU `-f`/`-e` recursive-resolve flags —
   * the same portability constraint `RemotePathResolver` documents for
   * `realpath`), then resolves the final directory component with the same
   * `cd -- ... && pwd -P` trick `RemotePathResolver` uses.
   */
  async resolveExistingTargetRealPath(srv: ServerConfig, filePath: string): Promise<string | null> {
    if (srv.type === 'local') {
      const fs = await import('fs');
      try {
        return await fs.promises.realpath(filePath);
      } catch {
        return null;
      }
    }
    const q = sq(filePath);
    const exists = await this.tmux.execCommand(srv, `test -e ${q} && echo yes || echo no`);
    if (stripTerminalArtifacts(exists.stdout).trim() !== 'yes') return null;
    const script = [
      `p=${q}`,
      'i=0',
      'while [ -L "$p" ] && [ "$i" -lt 20 ]; do',
      '  t=$(readlink -- "$p") || break',
      '  case "$t" in',
      '    /*) p="$t" ;;',
      '    *) p="$(dirname -- "$p")/$t" ;;',
      '  esac',
      '  i=$((i+1))',
      'done',
      'd=$(dirname -- "$p")',
      'b=$(basename -- "$p")',
      'cd -- "$d" 2>/dev/null && printf \'%s/%s\\n\' "$(pwd -P)" "$b"',
    ].join('\n');
    const result = await this.tmux.execCommand(srv, script);
    const resolved = stripTerminalArtifacts(result.stdout).trim();
    return resolved || null;
  }

  async createEntry(srv: ServerConfig, targetPath: string, type: 'file' | 'directory'): Promise<void> {
    if (srv.type === 'local') {
      const fs = await import('fs');
      if (fs.existsSync(targetPath)) throw new FileBrowseError('Already exists', 409);
      if (type === 'directory') {
        fs.mkdirSync(targetPath);
      } else {
        fs.writeFileSync(targetPath, '', { flag: 'wx' });
      }
      return;
    }
    const q = sq(targetPath);
    const exists = await this.tmux.execCommand(srv, `test -e ${q} && echo yes || echo no`);
    if (stripTerminalArtifacts(exists.stdout).trim() === 'yes') throw new FileBrowseError('Already exists', 409);
    const cmd = type === 'directory' ? `mkdir ${q}` : `set -C; : > ${q}`;
    await this.tmux.execCommand(srv, cmd);
    const verify = await this.tmux.execCommand(srv, `test -e ${q} && echo ok || echo ng`);
    if (stripTerminalArtifacts(verify.stdout).trim() !== 'ok') throw new FileBrowseError('Create failed', 500);
  }

  async deleteEntry(srv: ServerConfig, targetPath: string): Promise<void> {
    if (srv.type === 'local') {
      const fs = await import('fs');
      if (!fs.existsSync(targetPath)) throw new FileBrowseError('Not found', 404);
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    }
    const q = sq(targetPath);
    const exists = await this.tmux.execCommand(srv, `test -e ${q} && echo yes || echo no`);
    if (stripTerminalArtifacts(exists.stdout).trim() !== 'yes') throw new FileBrowseError('Not found', 404);
    await this.tmux.execCommand(srv, `rm -rf ${q}`);
    const verify = await this.tmux.execCommand(srv, `test -e ${q} && echo yes || echo no`);
    if (stripTerminalArtifacts(verify.stdout).trim() === 'yes') throw new FileBrowseError('Delete failed', 500);
  }

  async renameEntry(srv: ServerConfig, oldPath: string, newName: string): Promise<void> {
    const newPath = path.join(path.dirname(oldPath), newName);
    if (srv.type === 'local') {
      const fs = await import('fs');
      if (!fs.existsSync(oldPath)) throw new FileBrowseError('Not found', 404);
      if (fs.existsSync(newPath)) throw new FileBrowseError('Already exists', 409);
      fs.renameSync(oldPath, newPath);
      return;
    }
    const qOld = sq(oldPath);
    const qNew = sq(newPath);
    const existsOld = await this.tmux.execCommand(srv, `test -e ${qOld} && echo yes || echo no`);
    if (stripTerminalArtifacts(existsOld.stdout).trim() !== 'yes') throw new FileBrowseError('Not found', 404);
    const existsNew = await this.tmux.execCommand(srv, `test -e ${qNew} && echo yes || echo no`);
    if (stripTerminalArtifacts(existsNew.stdout).trim() === 'yes') throw new FileBrowseError('Already exists', 409);
    await this.tmux.execCommand(srv, `mv -n ${qOld} ${qNew}`);
    const verify = await this.tmux.execCommand(srv, `test -e ${qNew} && echo ok || echo ng`);
    if (stripTerminalArtifacts(verify.stdout).trim() !== 'ok') throw new FileBrowseError('Rename failed', 500);
  }

  /** GET /api/servers/:name/files/download 用: ファイルダウンロード */
  async downloadFile(srv: ServerConfig, filePath: string): Promise<FileDownloadResult> {
    const pathMod = await import('path');
    const basename = pathMod.basename(filePath);
    const ext = pathMod.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (srv.type === 'local') {
      const fs = await import('fs');
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new FileBrowseError('Not a regular file', 400);
      if (stat.size > MAX_DOWNLOAD_SIZE) {
        throw new FileBrowseError(`File too large (${Math.round(stat.size / 1024 / 1024)}MB). Maximum is 50MB.`, 400);
      }
      const buffer = fs.readFileSync(filePath);
      return { buffer, contentType, basename };
    } else {
      // Remote: reject non-regular files, then check size
      const typeCheck = await this.tmux.execCommand(srv, `test -f ${sq(filePath)} && echo ok || echo ng`);
      if (typeCheck.stdout.trim() !== 'ok') throw new FileBrowseError('Not a regular file', 400);
      const sizeResult = await this.tmux.execCommand(srv, `stat -c%s ${sq(filePath)} 2>/dev/null || stat -f%z ${sq(filePath)} 2>/dev/null`);
      const size = parseInt(sizeResult.stdout.trim(), 10) || 0;
      if (size > MAX_DOWNLOAD_SIZE) {
        throw new FileBrowseError(`File too large (${Math.round(size / 1024 / 1024)}MB). Maximum is 50MB.`, 400);
      }
      // Use base64 to safely transfer binary content over SSH
      const result = await this.tmux.execCommand(srv, `base64 -- ${sq(filePath)}`);
      const raw = stripTerminalArtifacts(result.stdout).replace(/\s/g, '');
      const buffer = Buffer.from(raw, 'base64');
      return { buffer, contentType, basename };
    }
  }
}
