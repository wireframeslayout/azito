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
  type WalkEntry,
  type WalkOptions,
  type WalkResult,
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

  private async out(command: string, timeoutMs?: number): Promise<string> {
    return stripTerminalArtifacts((await this.transport.exec(command, timeoutMs)).stdout);
  }

  async list(dir: string): Promise<DirEntry[]> {
    const stdout = await this.out(`LC_ALL=C command find ${sq(this.checked(dir))} -maxdepth 1 -mindepth 1 -printf '%y %s %T@ %f\\n' 2>/dev/null | sort`);
    const entries: DirEntry[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.match(/^(\S)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(.+)$/);
      if (!match) continue;
      const [, typeChar, sizeText, mtimeText, name] = match;
      if (name === '.' || name === '..') continue;
      const kind: EntryKind = typeChar === 'd' ? 'directory' : typeChar === 'f' ? 'file' : typeChar === 'l' ? 'symlink' : 'other';
      entries.push(kind === 'directory' ? { name, kind } : { name, kind, size: parseInt(sizeText, 10) || 0, mtimeMs: parseFloat(mtimeText) * 1000 });
    }
    return entries;
  }

  async stat(path: string, options: { followLinks?: boolean; withAge?: boolean } = {}): Promise<FileStat | null> {
    return (await this.statPrecise(path, options.followLinks !== false, options.withAge === true))?.stat ?? null;
  }

  /** The stat, with whether the mtime has sub-second precision (GNU `%.Y`) or is whole seconds (older / BSD `stat`). */
  private async statPrecise(path: string, followLinks: boolean, withAge = false): Promise<{ stat: FileStat; precise: boolean } | null> {
    const q = sq(this.checked(path));
    // Without following links, a symbolic link is reported as one before anything is looked through.
    const linkTest = followLinks ? '' : `if [ -L ${q} ]; then echo l; exit 0; fi; `;
    const kindOut = (await this.out(`${linkTest}if [ -d ${q} ]; then echo d; elif [ -f ${q} ]; then echo f; elif [ -e ${q} ]; then echo o; else echo n; fi`)).trim();
    if (kindOut === 'n') return null;
    const kind: EntryKind = kindOut === 'd' ? 'directory' : kindOut === 'f' ? 'file' : kindOut === 'l' ? 'symlink' : 'other';
    const link = followLinks ? '-L ' : '';
    // The age is the host's own `date` against the mtime it reported, so the host's clock is the only one involved.
    const statLine = `stat ${link}-c '%s %.Y %a' ${q} 2>/dev/null || stat ${link}-c '%s %Y %a' ${q} 2>/dev/null || stat ${link}-f '%z %m %Lp' ${q} 2>/dev/null`;
    const fields = (await this.out(withAge ? `{ ${statLine}; } && date +%s` : statLine)).trim().split(/\s+/);
    const size = parseInt(fields[0], 10);
    const seconds = parseFloat(fields[1]);
    const nowSeconds = withAge ? parseInt(fields[3], 10) : 0;
    if (fields.length !== (withAge ? 4 : 3) || isNaN(size) || isNaN(seconds) || isNaN(nowSeconds)) return null;
    const stat: FileStat = { kind, size, mtimeMs: seconds * 1000, mode: parseInt(fields[2], 8) || 0 };
    if (withAge) stat.ageMs = nowSeconds * 1000 - stat.mtimeMs;
    return { stat, precise: fields[1].includes('.') };
  }

  async read(path: string, options: { maxBytes?: number; headBytes?: number } = {}): Promise<FileContent> {
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
    // to the wrapped form, whose line breaks are removed below. The marker tells a failed read from an empty file. A head read
    // takes the first bytes with `head -c` (plain `base64` wraps or not, depending on the host; the breaks are removed alike).
    if (options.headBytes !== undefined && !(Number.isInteger(options.headBytes) && options.headBytes > 0)) {
      throw new FileOpsError('FAILED', 'headBytes must be a positive integer');
    }
    const encode = options.headBytes !== undefined
      ? `[ -r ${q} ] && head -c ${options.headBytes} < ${q} | base64`
      : `(base64 -w0 < ${q} 2>/dev/null || base64 < ${q} 2>/dev/null)`;
    const stdout = await this.out(`${encode} && echo AZITO_READ_OK`);
    if (!stdout.includes('AZITO_READ_OK')) throw new FileOpsError('FAILED', 'Failed to read file');
    const data = Buffer.from(stdout.replace('AZITO_READ_OK', '').replace(/[\r\n]/g, ''), 'base64');
    if (options.headBytes === undefined && data.length !== stat.size) throw new FileOpsError('FAILED', 'Failed to read file: content size mismatch');
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
   * `find` does the walk on the host, as the file-name search and the session scans always did: GNU `-printf`, the excluded names
   * pruned, `head` cutting the output at the limit, and the time budget as the exec deadline (a walk that runs out of time has no
   * partial output to return, so it reports `truncated` with nothing). Entries come in `find`'s order, not level by level.
   */
  async walk(root: string, options: WalkOptions): Promise<WalkResult> {
    const q = sq(this.checked(root));
    const prune = options.excludeNames.length > 0 ? `\\( ${options.excludeNames.map((glob) => `-name ${sq(glob)}`).join(' -o ')} \\) -prune -o ` : '';
    const depth = options.maxDepth === undefined ? '' : ` -maxdepth ${options.maxDepth + 1}`;
    const command =
      `if [ -d ${q} ]; then LC_ALL=C command find ${q} -mindepth 1${depth} ${prune}-type f -printf '%T@ %P\\n' 2>/dev/null | head -n ${options.maxEntries + 1}; ` +
      `else echo AZITO_NOT_A_DIRECTORY; fi`;
    let stdout: string;
    try {
      stdout = await this.out(command, options.timeBudgetMs);
    } catch (err) {
      if (err instanceof Error && ((err as Error & { killed?: boolean }).killed === true || err.message.includes('timed out'))) return { entries: [], truncated: true };
      throw err;
    }
    if (stdout.startsWith('AZITO_NOT_A_DIRECTORY')) throw new FileOpsError('NOT_FOUND', `No such directory: ${root}`);
    const entries: WalkEntry[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\d+(?:\.\d+)?) (.+)$/);
      if (match) entries.push({ path: match[2], mtimeMs: parseFloat(match[1]) * 1000 });
    }
    const truncated = entries.length > options.maxEntries;
    return { entries: truncated ? entries.slice(0, options.maxEntries) : entries, truncated };
  }

  /** One script: the old tree is moved aside, `staging` moved in, and the old tree removed only after that; if the move in fails, the old tree is moved back. */
  async replaceDirectory(staging: string, target: string): Promise<void> {
    const qStaging = sq(this.checked(staging));
    const qTarget = sq(this.checked(target));
    const qBackup = sq(`${this.checked(target)}.azito-old-${randomBytes(8).toString('hex')}`);
    const script = [
      `if [ ! -d ${qStaging} ]; then echo AZITO_NO_STAGING; exit 0; fi`,
      `had=0; if [ -e ${qTarget} ] || [ -L ${qTarget} ]; then mv ${qTarget} ${qBackup} || { echo AZITO_REPLACE_FAILED; exit 0; }; had=1; fi`,
      `if mv ${qStaging} ${qTarget}; then rm -rf ${qBackup}; echo AZITO_REPLACE_OK;`,
      `else if [ "$had" = 1 ]; then mv ${qBackup} ${qTarget} || echo AZITO_BACKUP_KEPT; fi; echo AZITO_REPLACE_FAILED; fi`,
    ].join('\n');
    const stdout = await this.out(script);
    if (stdout.includes('AZITO_NO_STAGING')) throw new FileOpsError('NOT_FOUND', `No such directory: ${staging}`);
    if (stdout.includes('AZITO_BACKUP_KEPT')) throw new FileOpsError('FAILED', `Replace failed and the previous content could not be put back; it is at ${target}.azito-old-*`);
    if (!stdout.includes('AZITO_REPLACE_OK')) throw new FileOpsError('FAILED', 'Replace failed; the previous content was put back');
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
}

/** Whether `files` is the shell implementation, i.e. the agent behind it predates `/api/fileops` (a route fixed before the call). */
export function isShellFileOps(files: IFileOps): files is ShellFileOps {
  return files instanceof ShellFileOps;
}
