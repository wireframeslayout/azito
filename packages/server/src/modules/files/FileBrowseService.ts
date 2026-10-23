import { createHash } from 'crypto';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { pathApiFor } from '../../shared/os/hostPath';

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

/** The content hash the optimistic lock compares: sha256 of the file's bytes, hex-encoded. The host computes the same for a write. */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface BrowseMessages {
  tooLarge?: (size: number) => string;
}

/** What a file operation's refusal is to the file APIs: the HTTP status and message each caller answers with. Anything else stays an unexpected error (a 500 with its message). */
function toBrowseError(err: unknown, messages: BrowseMessages = {}): unknown {
  if (!(err instanceof FileOpsError)) return err;
  switch (err.code) {
    case 'NOT_FOUND': return new FileBrowseError('Not found', 404);
    case 'NOT_A_FILE': return new FileBrowseError('Not a regular file', 400);
    case 'NOT_A_DIRECTORY': return new FileBrowseError('Not a directory', 400);
    case 'TOO_LARGE': return new FileBrowseError(messages.tooLarge?.(err.details.size ?? 0) ?? err.message, 400);
    case 'PERMISSION_DENIED': return new FileBrowseError(err.message, 403);
    case 'INVALID_PATH': return new FileBrowseError('Invalid path', 400);
    case 'SYMLINK_REFUSED': return new FileBrowseError('Refusing to write through a symlink', 400);
    case 'FAILED': return new FileBrowseError(err.message, 500);
    default: return err;
  }
}

async function browsing<T>(run: () => Promise<T>, messages?: BrowseMessages): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toBrowseError(err, messages);
  }
}

const sizeKb = (size: number): number => Math.round(size / 1024);

export class FileBrowseService {
  constructor(private readonly transportFactory: Pick<TransportFactory, 'getFileOps'>) {}

  private ops(srv: ServerConfig): IFileOps {
    return this.transportFactory.getFileOps(srv);
  }

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
    const ops = this.ops(srv);
    const api = pathApiFor(ops.platform);
    const endsWithSeparator = ops.platform === 'win32' ? /[\\/]$/.test(inputPath) : inputPath.endsWith('/');
    const dir = endsWithSeparator ? inputPath : api.dirname(inputPath);
    const prefix = endsWithSeparator ? '' : api.basename(inputPath).toLowerCase();
    try {
      return (await ops.list(dir))
        .filter((entry) => entry.kind === 'directory' && !entry.name.startsWith('.'))
        .filter((entry) => !prefix || entry.name.toLowerCase().startsWith(prefix))
        .map((entry) => api.join(dir, entry.name))
        .slice(0, 20);
    } catch {
      // A directory that does not exist (or cannot be read) simply has no candidates: this is an autocomplete, not a lookup.
      return [];
    }
  }

  /** GET /api/servers/:name/files 用: ディレクトリ内エントリ一覧 */
  async listFiles(srv: ServerConfig, dirPath: string, showHidden: boolean): Promise<FileEntry[]> {
    const ops = this.ops(srv);
    const separator = pathApiFor(ops.platform).sep;
    const entries: FileEntry[] = (await browsing(() => ops.list(dirPath)))
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => {
        const isDir = entry.kind === 'directory';
        const item: FileEntry = {
          name: entry.name,
          type: isDir ? 'directory' : 'file',
          path: /[\\/]$/.test(dirPath) ? dirPath + entry.name : dirPath + separator + entry.name,
        };
        if (!isDir && entry.size !== undefined) item.size = entry.size;
        return item;
      });
    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /** GET /api/servers/:name/files/content 用: ファイル内容（画像/PDF/テキスト） */
  async getFileContent(srv: ServerConfig, filePath: string): Promise<FileContentResult> {
    const ops = this.ops(srv);
    const ext = pathApiFor(ops.platform).extname(filePath).toLowerCase();

    // ── Image file preview ──
    if (IMAGE_EXTS.has(ext)) {
      const { data, stat } = await browsing(() => ops.read(filePath, { maxBytes: MAX_IMAGE_SIZE }), {
        tooLarge: (size) => `Image too large (${sizeKb(size)}KB). Maximum is 5MB.`,
      });
      return { type: 'image', mimeType: IMAGE_MIME[ext] || 'application/octet-stream', base64: data.toString('base64'), path: filePath, size: stat.size };
    }

    // ── PDF file preview ──
    if (ext === '.pdf') {
      const { data, stat } = await browsing(() => ops.read(filePath, { maxBytes: MAX_IMAGE_SIZE }), {
        tooLarge: (size) => `PDF too large (${sizeKb(size)}KB). Maximum is 5MB.`,
      });
      return { type: 'pdf', mimeType: 'application/pdf', base64: data.toString('base64'), path: filePath, size: stat.size };
    }

    if (BINARY_EXTS.has(ext)) {
      throw new FileBrowseError('Binary file cannot be displayed', 400);
    }

    const { data, stat } = await browsing(() => ops.read(filePath, { maxBytes: MAX_FILE_SIZE }), {
      tooLarge: (size) => `File too large (${sizeKb(size)}KB). Maximum is 500KB.`,
    });
    // The bytes are checked, hashed and sized together, so the hash a later save sends back is the one the host computes.
    if (data.includes(0)) {
      throw new FileBrowseError('Binary file cannot be displayed', 400);
    }
    return { content: data.toString('utf-8'), path: filePath, size: stat.size, language: EXT_LANG[ext] || 'text', mtime: stat.mtimeMs, hash: sha256Hex(data) };
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
    return this.withWriteLock(`${srv.name}:${filePath}`, async () => {
      // The optimistic lock is checked by the host right before it replaces the file (the mtime, and the content hash); a
      // caller that sends neither asked for `force`. The conflict carries the mtime the file has now.
      const expect = baseMtime !== undefined || baseHash !== undefined ? { mtimeMs: baseMtime, sha256: baseHash } : undefined;
      try {
        const result = await this.ops(srv).write(filePath, Buffer.from(content, 'utf-8'), { expect });
        return { mtime: result.mtimeMs, hash: result.sha256 };
      } catch (err) {
        if (err instanceof FileOpsError && err.code === 'CONFLICT') {
          const { currentMtimeMs = null, hashUnavailable } = err.details;
          throw new FileBrowseError(JSON.stringify({ conflict: true, currentMtime: currentMtimeMs, ...(hashUnavailable ? { hashUnavailable: true } : {}) }), 409);
        }
        throw toBrowseError(err);
      }
    });
  }

  /**
   * Resolves the real (symlink-free) path of `filePath` if it currently exists, or returns `null` if it does not. Used by the
   * PUT files/content route so a save can be rejected — before any bytes are written — when the target itself is a symlink
   * pointing outside the project's `workingDirectory` (Issue #27 review Critical 2: only the parent directory was
   * containment-checked, so a symlinked save target could redirect the write anywhere on disk).
   */
  async resolveExistingTargetRealPath(srv: ServerConfig, filePath: string): Promise<string | null> {
    try {
      return await this.ops(srv).realpath(filePath);
    } catch (err) {
      if (err instanceof FileOpsError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  /**
   * Creates `targetPath` as a directory, recursively (parent components that don't exist yet are created too — `mkdir -p`
   * semantics), and is idempotent: an already-existing directory is a no-op success. Used by the project wizard to actually
   * create the root it told the operator "このパスを作成します" about (indicator 1: the wizard used to accept that
   * `exists: false` discovery result and just save the path as `working_directory` without ever creating it, so task
   * execution's containment resolution later failed against a root that was never created).
   *
   * A path that already exists but is NOT a directory (a file/symlink/etc. sitting at that location) fails loudly (409)
   * rather than silently proceeding — creating the environment on top of it would be wrong.
   */
  async ensureDirectory(srv: ServerConfig, targetPath: string): Promise<{ created: boolean }> {
    try {
      return await this.ops(srv).create(targetPath, 'directory', { recursive: true });
    } catch (err) {
      if (err instanceof FileOpsError && err.code === 'ALREADY_EXISTS') throw new FileBrowseError('Path already exists and is not a directory', 409);
      throw toBrowseError(err);
    }
  }

  async createEntry(srv: ServerConfig, targetPath: string, type: 'file' | 'directory'): Promise<void> {
    try {
      await this.ops(srv).create(targetPath, type);
    } catch (err) {
      if (err instanceof FileOpsError && err.code === 'ALREADY_EXISTS') throw new FileBrowseError('Already exists', 409);
      throw toBrowseError(err);
    }
  }

  async deleteEntry(srv: ServerConfig, targetPath: string): Promise<void> {
    await browsing(() => this.ops(srv).remove(targetPath));
  }

  async renameEntry(srv: ServerConfig, oldPath: string, newName: string): Promise<void> {
    const ops = this.ops(srv);
    const api = pathApiFor(ops.platform);
    try {
      await ops.rename(oldPath, api.join(api.dirname(oldPath), newName));
    } catch (err) {
      if (err instanceof FileOpsError && err.code === 'ALREADY_EXISTS') throw new FileBrowseError('Already exists', 409);
      throw toBrowseError(err);
    }
  }

  /** GET /api/servers/:name/files/download 用: ファイルダウンロード */
  async downloadFile(srv: ServerConfig, filePath: string): Promise<FileDownloadResult> {
    const ops = this.ops(srv);
    const api = pathApiFor(ops.platform);
    const { data } = await browsing(() => ops.read(filePath, { maxBytes: MAX_DOWNLOAD_SIZE }), {
      tooLarge: (size) => `File too large (${Math.round(size / 1024 / 1024)}MB). Maximum is 50MB.`,
    });
    return { buffer: data, contentType: MIME_TYPES[api.extname(filePath).toLowerCase()] || 'application/octet-stream', basename: api.basename(filePath) };
  }
}
