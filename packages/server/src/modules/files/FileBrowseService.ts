import * as path from 'path';
import type { ServerConfig } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';
import { shellQuote } from '../../shared/shellQuote';

const sq = shellQuote;

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
  | { content: string; path: string; size: number; language: string; mtime: number };

export interface FileDownloadResult {
  buffer: Buffer;
  contentType: string;
  basename: string;
}

// ─── Service ───

export class FileBrowseService {
  constructor(private readonly tmux: TmuxClient) {}

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
        const safeDir = dir.replace(/'/g, "'\\''");
        const cmd = `LC_ALL=C command find '${safeDir}' -maxdepth 1 -mindepth 1 -type d -printf '%f\\n' 2>/dev/null | head -20`;
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
    const safePath = dirPath.replace(/'/g, "'\\''");
    const hiddenFilter = showHidden ? '' : " ! -name '.*'";
    const cmd = `LC_ALL=C command find '${safePath}' -maxdepth 1 -mindepth 1${hiddenFilter} -printf '%y %s %f\\n' 2>/dev/null | sort`;
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
      return { content, path: filePath, size: stat.size, language, mtime: stat.mtimeMs };
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
      const mtimeResult = await this.tmux.execCommand(
        srv,
        `stat -c%Y "${filePath}" 2>/dev/null || stat -f%m "${filePath}" 2>/dev/null`,
      );
      const mtime = parseInt(stripTerminalArtifacts(mtimeResult.stdout).trim(), 10) * 1000;
      return { content, path: filePath, size, language, mtime: isNaN(mtime) ? 0 : mtime };
    }
  }

  async writeFileContent(
    srv: ServerConfig,
    filePath: string,
    content: string,
    baseMtime?: number,
  ): Promise<{ mtime: number }> {
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
      throw new FileBrowseError(`Content too large. Maximum is 500KB.`, 400);
    }

    if (srv.type === 'local') {
      const fs = await import('fs');
      if (baseMtime != null) {
        const stat = fs.statSync(filePath);
        if (Math.abs(stat.mtimeMs - baseMtime) > 1000) {
          throw new FileBrowseError(
            JSON.stringify({ conflict: true, currentMtime: stat.mtimeMs }),
            409,
          );
        }
      }
      fs.writeFileSync(filePath, content, 'utf-8');
      const newStat = fs.statSync(filePath);
      return { mtime: newStat.mtimeMs };
    } else {
      const safePath = filePath.replace(/'/g, "'\\''");
      if (baseMtime != null) {
        const mtimeResult = await this.tmux.execCommand(
          srv,
          `stat -c%Y '${safePath}' 2>/dev/null || stat -f%m '${safePath}' 2>/dev/null`,
        );
        const currentMtime = parseInt(stripTerminalArtifacts(mtimeResult.stdout).trim(), 10) * 1000;
        if (!isNaN(currentMtime) && Math.abs(currentMtime - baseMtime) > 1000) {
          throw new FileBrowseError(
            JSON.stringify({ conflict: true, currentMtime }),
            409,
          );
        }
      }
      // agent/ssh の exec は base64 全文を1コマンド引数に載せると Linux の
      // MAX_ARG_STRLEN(≒128KB) を超えて spawn E2BIG になるため、チャンク分割で
      // 一時ファイルに追記してからデコードする
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      const tmpPath = `${safePath}.azito-write-tmp`;
      await this.tmux.execCommand(srv, `: > '${tmpPath}'`);
      for (let i = 0; i < b64.length; i += WRITE_CHUNK_SIZE) {
        const chunk = b64.slice(i, i + WRITE_CHUNK_SIZE);
        await this.tmux.execCommand(srv, `printf '%s' '${chunk}' >> '${tmpPath}'`);
      }
      await this.tmux.execCommand(
        srv,
        `base64 -d < '${tmpPath}' > '${safePath}'; S=$?; rm -f '${tmpPath}'; exit $S`,
      );
      const verifyResult = await this.tmux.execCommand(
        srv,
        `stat -c%Y '${safePath}' 2>/dev/null || stat -f%m '${safePath}' 2>/dev/null`,
      );
      const newMtime = parseInt(stripTerminalArtifacts(verifyResult.stdout).trim(), 10) * 1000;
      if (isNaN(newMtime)) {
        throw new FileBrowseError('Failed to verify file write', 500);
      }
      return { mtime: newMtime };
    }
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
