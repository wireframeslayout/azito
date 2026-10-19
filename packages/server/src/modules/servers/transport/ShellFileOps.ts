import { createHash, randomBytes } from 'crypto';
import type { HostPlatform } from '../../../shared/os/hostEnv';
import { invalidHostPathReason } from '../../../shared/os/hostPath';
import { shellQuote as sq } from '../../../shared/shellQuote';
import { stripTerminalArtifacts } from '../../../shared/utils/stripTerminalArtifacts';
import {
  FileOpsError,
  type DirEntry,
  type EntryKind,
  type FileContent,
  type FileStat,
  type IFileOps,
  type WriteOptions,
  type WriteResult,
} from '../../../shared/fs/fileOps';
import type { IServerTransport } from './ServerTransport';

// base64 chunk length of an upload: the whole command must stay under Linux's MAX_ARG_STRLEN (128KB).
const WRITE_CHUNK_SIZE = 48 * 1024;

/**
 * {@link IFileOps} for an agent registered before its OS was recorded (a Unix one that has no `/api/fileops`): each operation
 * is a POSIX shell command through `exec`, as the hub's file browser always did. Chosen once, from the recorded host (see
 * `TransportFactory.getFileOps`); a failure is never retried through another route. The agent update that records the
 * host brings `/api/fileops`, after which this class is no longer used for that server.
 *
 * It keeps the legacy limits: an mtime is compared to the second on a host whose `stat` has no sub-second field, a write
 * needs `sha256sum` / `shasum` to check a content hash, and `list` shows nothing for a directory `find` cannot read.
 */
export class ShellFileOps implements IFileOps {
  /** An unrecorded agent is a Unix one. */
  readonly platform: HostPlatform = 'linux';

  constructor(private readonly transport: Pick<IServerTransport, 'exec'>) {}

  private checked(input: string): string {
    const reason = invalidHostPathReason(this.platform, input);
    if (reason !== null) throw new FileOpsError('INVALID_PATH', `Invalid path: ${reason}`);
    // A line terminator cannot be told from the end of a command's output.
    if (/[\r\n]/.test(input)) throw new FileOpsError('INVALID_PATH', 'Invalid path: the path contains a line terminator');
    return input;
  }

  private async out(command: string): Promise<string> {
    return stripTerminalArtifacts((await this.transport.exec(command)).stdout);
  }

  async list(dir: string): Promise<DirEntry[]> {
    const stdout = await this.out(`LC_ALL=C command find ${sq(this.checked(dir))} -maxdepth 1 -mindepth 1 -printf '%y %s %f\\n' 2>/dev/null | sort`);
    const entries: DirEntry[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.match(/^(\S)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, typeChar, sizeText, name] = match;
      if (name === '.' || name === '..') continue;
      const kind: EntryKind = typeChar === 'd' ? 'directory' : typeChar === 'f' ? 'file' : typeChar === 'l' ? 'symlink' : 'other';
      entries.push(kind === 'directory' ? { name, kind } : { name, kind, size: parseInt(sizeText, 10) || 0 });
    }
    return entries;
  }

  async stat(path: string, options: { followLinks?: boolean } = {}): Promise<FileStat | null> {
    return (await this.statPrecise(path, options.followLinks !== false))?.stat ?? null;
  }

  /** The stat, with whether the mtime has sub-second precision (GNU `%.Y`) or is whole seconds (older / BSD `stat`). */
  private async statPrecise(path: string, followLinks: boolean): Promise<{ stat: FileStat; precise: boolean } | null> {
    const q = sq(this.checked(path));
    // Without following links, a symbolic link is reported as one before anything is looked through.
    const linkTest = followLinks ? '' : `if [ -L ${q} ]; then echo l; exit 0; fi; `;
    const kindOut = (await this.out(`${linkTest}if [ -d ${q} ]; then echo d; elif [ -f ${q} ]; then echo f; elif [ -e ${q} ]; then echo o; else echo n; fi`)).trim();
    if (kindOut === 'n') return null;
    const kind: EntryKind = kindOut === 'd' ? 'directory' : kindOut === 'f' ? 'file' : kindOut === 'l' ? 'symlink' : 'other';
    const link = followLinks ? '-L ' : '';
    const fields = (await this.out(
      `stat ${link}-c '%s %.Y %a' ${q} 2>/dev/null || stat ${link}-c '%s %Y %a' ${q} 2>/dev/null || stat ${link}-f '%z %m %Lp' ${q} 2>/dev/null`,
    )).trim().split(/\s+/);
    const size = parseInt(fields[0], 10);
    const seconds = parseFloat(fields[1]);
    if (fields.length !== 3 || isNaN(size) || isNaN(seconds)) return null;
    return { stat: { kind, size, mtimeMs: seconds * 1000, mode: parseInt(fields[2], 8) || 0 }, precise: fields[1].includes('.') };
  }

  async read(path: string, options: { maxBytes?: number } = {}): Promise<FileContent> {
    const q = sq(this.checked(path));
    const found = await this.statPrecise(path, true);
    if (!found) throw new FileOpsError('NOT_FOUND', `No such file: ${path}`);
    const { stat } = found;
    if (stat.kind !== 'file') throw new FileOpsError('NOT_A_FILE', `Not a regular file: ${path}`);
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      throw new FileOpsError('TOO_LARGE', `File too large (${stat.size} bytes, limit ${options.maxBytes})`, { size: stat.size });
    }
    // The file goes through base64 so that no byte of it can be taken for the end of the command's output (a plain `cat` lost
    // a trailing newline). `< file` instead of an argument because BSD `base64` has no `--`; `-w0` is GNU-only, so it falls back
    // to the wrapped form, whose line breaks are removed below. The marker tells a failed read from an empty file.
    const stdout = await this.out(`(base64 -w0 < ${q} 2>/dev/null || base64 < ${q} 2>/dev/null) && echo AZITO_READ_OK`);
    if (!stdout.includes('AZITO_READ_OK')) throw new FileOpsError('FAILED', 'Failed to read file');
    const data = Buffer.from(stdout.replace('AZITO_READ_OK', '').replace(/[\r\n]/g, ''), 'base64');
    if (data.length !== stat.size) throw new FileOpsError('FAILED', 'Failed to read file: content size mismatch');
    return { data, stat };
  }

  async write(path: string, data: Buffer, options: WriteOptions = {}): Promise<WriteResult> {
    const target = this.checked(path);
    const q = sq(target);
    if (options.expect) await this.assertUnchanged(target, options.expect);

    // Keeps an existing file's permission bits across the replace (the staged file is created owner-only).
    const existingMode = (await this.out(`stat -c%a ${q} 2>/dev/null || stat -f%Lp ${q} 2>/dev/null`)).trim();
    const nonce = randomBytes(8).toString('hex');
    const qUpload = sq(`${target}.azito-upload-${nonce}`);
    const qDecoded = sq(`${target}.azito-decoded-${nonce}`);
    const b64 = data.toString('base64');
    await this.transport.exec(`umask 077; : > ${qUpload}`);
    try {
      for (let i = 0; i < b64.length; i += WRITE_CHUNK_SIZE) {
        await this.transport.exec(`printf '%s' ${sq(b64.slice(i, i + WRITE_CHUNK_SIZE))} >> ${qUpload}`);
      }
      // The success marker, not the exit code, decides (an old SSH route always reported 0). The staged byte count is checked
      // against what was sent before anything is decoded or replaced; BSD `base64` decodes with -D, not -d.
      const chmodStep = /^[0-7]{3,4}$/.test(existingMode) ? ` && chmod ${sq(existingMode)} ${qDecoded}` : '';
      const decodeStep = `(base64 -d < ${qUpload} > ${qDecoded} 2>/dev/null || { : > ${qDecoded}; base64 -D < ${qUpload} > ${qDecoded}; })`;
      const cleanup = `rm -f ${qUpload} ${qDecoded}`;
      const stdout = stripTerminalArtifacts((await this.transport.exec(
        `umask 077; trap ${sq(cleanup)} EXIT; ` +
        `u=$(wc -c < ${qUpload} | tr -d ' '); ` +
        `if [ "$u" = ${b64.length} ]; then ${decodeStep}${chmodStep} && mv -f ${qDecoded} ${q} && echo AZITO_WRITE_OK; ` +
        `else echo AZITO_WRITE_SIZE_MISMATCH; fi`,
      )).stdout);
      if (stdout.includes('AZITO_WRITE_SIZE_MISMATCH')) throw new FileOpsError('FAILED', 'Failed to write file: staged content size mismatch');
      if (!stdout.includes('AZITO_WRITE_OK')) throw new FileOpsError('FAILED', 'Failed to write file');
    } catch (err) {
      await this.transport.exec(`rm -f ${qUpload} ${qDecoded}`).catch(() => {});
      throw err;
    }
    const written = await this.statPrecise(target, true);
    if (!written) throw new FileOpsError('FAILED', 'Failed to verify file write');
    return { mtimeMs: written.stat.mtimeMs, sha256: createHash('sha256').update(data).digest('hex') };
  }

  /** Fails closed: an mtime that cannot be read, or no hash tool when a hash was asked for, is a conflict, not a pass. */
  private async assertUnchanged(target: string, expect: NonNullable<WriteOptions['expect']>): Promise<void> {
    const current = await this.statPrecise(target, true);
    if (expect.mtimeMs !== undefined) {
      // Whole-second mtimes cannot tell two edits within a second apart, hence the tolerance (the hash below covers that).
      const tolerance = current?.precise ? 1 : 999;
      if (!current || Math.abs(current.stat.mtimeMs - expect.mtimeMs) > tolerance) {
        throw new FileOpsError('CONFLICT', 'The file changed since it was read', { currentMtimeMs: current?.stat.mtimeMs ?? null });
      }
    }
    if (expect.sha256 !== undefined) {
      const q = sq(target);
      const hash = (await this.out(`sha256sum ${q} 2>/dev/null || shasum -a 256 ${q} 2>/dev/null`)).trim().split(/\s+/, 1)[0];
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new FileOpsError('CONFLICT', 'The content hash could not be computed', { currentMtimeMs: null, hashUnavailable: true });
      }
      if (hash !== expect.sha256) throw new FileOpsError('CONFLICT', 'The file changed since it was read', { currentMtimeMs: current?.stat.mtimeMs ?? null });
    }
  }

  async create(path: string, kind: 'file' | 'directory', options: { recursive?: boolean } = {}): Promise<{ created: boolean }> {
    const q = sq(this.checked(path));
    const state = (await this.out(`if [ -d ${q} ]; then echo dir; elif [ -e ${q} ]; then echo other; else echo none; fi`)).trim();
    if (state === 'dir' && kind === 'directory' && options.recursive) return { created: false };
    if (state !== 'none') throw new FileOpsError('ALREADY_EXISTS', `Already exists: ${path}`);
    await this.transport.exec(kind === 'directory' ? `mkdir ${options.recursive ? '-p ' : ''}${q}` : `set -C; : > ${q}`);
    if ((await this.out(`test -e ${q} && echo ok || echo ng`)).trim() !== 'ok') throw new FileOpsError('FAILED', 'Create failed');
    return { created: true };
  }

  async remove(path: string): Promise<void> {
    const q = sq(this.checked(path));
    if ((await this.out(`test -e ${q} && echo yes || echo no`)).trim() !== 'yes') throw new FileOpsError('NOT_FOUND', `No such file or directory: ${path}`);
    await this.transport.exec(`rm -rf ${q}`);
    if ((await this.out(`test -e ${q} && echo yes || echo no`)).trim() === 'yes') throw new FileOpsError('FAILED', 'Delete failed');
  }

  async rename(from: string, to: string): Promise<void> {
    const qFrom = sq(this.checked(from));
    const qTo = sq(this.checked(to));
    if ((await this.out(`test -e ${qFrom} && echo yes || echo no`)).trim() !== 'yes') throw new FileOpsError('NOT_FOUND', `No such file or directory: ${from}`);
    if ((await this.out(`test -e ${qTo} && echo yes || echo no`)).trim() === 'yes') throw new FileOpsError('ALREADY_EXISTS', `Already exists: ${to}`);
    await this.transport.exec(`mv -n ${qFrom} ${qTo}`);
    if ((await this.out(`test -e ${qTo} && echo ok || echo ng`)).trim() !== 'ok') throw new FileOpsError('FAILED', 'Rename failed');
  }

  /**
   * POSIX-portable (BSD/macOS `readlink` has no `-f`): follows up to 20 links with `readlink`, then resolves the directory part
   * with `cd -- … && pwd -P`. A leading `~` is the home directory: quoting the path whole would keep the shell from expanding it,
   * so `"$HOME"` is spliced in front of the quoted rest.
   */
  async realpath(path: string): Promise<string> {
    const target = this.checked(path);
    const expr = target === '~' ? '"$HOME"' : target.startsWith('~/') ? `"$HOME"${sq(target.slice(1))}` : sq(target);
    const script = [
      `p=${expr}`,
      'i=0',
      'while [ -L "$p" ] && [ "$i" -lt 20 ]; do',
      '  t=$(readlink -- "$p") || break',
      '  case "$t" in',
      '    /*) p="$t" ;;',
      '    *) p="$(dirname -- "$p")/$t" ;;',
      '  esac',
      '  i=$((i+1))',
      'done',
      'if [ -d "$p" ]; then cd -- "$p" 2>/dev/null && pwd -P',
      'elif [ -e "$p" ]; then',
      '  d=$(dirname -- "$p")',
      '  b=$(basename -- "$p")',
      '  cd -- "$d" 2>/dev/null && printf \'%s/%s\\n\' "$(pwd -P)" "$b"',
      'fi',
    ].join('\n');
    // Only the line terminator `pwd` adds is removed, not `trim()`: a name may begin or end with a space or a CR.
    const resolved = (await this.transport.exec(script)).stdout.replace(/\n$/, '');
    if (!resolved) throw new FileOpsError('NOT_FOUND', `realpath failed for '${path}'`);
    return resolved;
  }

  async which(command: string): Promise<string | null> {
    const found = (await this.out(`command -v -- ${sq(this.checked(command))} 2>/dev/null`)).trim();
    return found.startsWith('/') ? found : null;
  }

  async tmpPath(prefix: string): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(prefix)) throw new FileOpsError('INVALID_PATH', `Invalid temporary file prefix: ${prefix}`);
    return `/tmp/${prefix}-${randomBytes(8).toString('hex')}`;
  }
}
