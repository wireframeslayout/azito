import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import { promisify } from 'util';
import type { HostEnv, HostPlatform } from '../os/hostEnv';
import { invalidHostPathReason, pathApiFor, type HostPathApi } from '../os/hostPath';
import { pathDelimiterFor } from '../os/hostProfile';
import {
  FileOpsError,
  type DirEntry,
  type EntryKind,
  type FileContent,
  type FileStat,
  type IFileOps,
  type WriteOptions,
  type WriteResult,
} from './fileOps';

/** What a {@link LocalFileOps} needs to know of the host it runs on, resolved once at the process's entry point. */
export interface LocalFileOpsHost {
  platform: HostPlatform;
  homeDir: string;
  tmpDir: string;
  /** The host's PATH variable (undefined: not set, so no command is found by name). */
  pathEnv: string | undefined;
  /** The host's PATHEXT variable; only read on win32. */
  pathExt: string | undefined;
}

/** The Windows default of PATHEXT, used when the variable is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** An OS AZITO has no profile for (freebsd...) is handled with POSIX path rules, like an agent registered before its OS was recorded. */
function toFileOpsPlatform(platform: NodeJS.Platform): HostPlatform {
  if (platform === 'win32') return 'win32';
  return platform === 'darwin' ? 'darwin' : 'linux';
}

/** The boundary: reads the process environment once and hands the core resolved values. */
export function localFileOpsHostFromEnv(hostEnv: Pick<HostEnv, 'platform' | 'homeDir' | 'tmpDir'>, env: NodeJS.ProcessEnv): LocalFileOpsHost {
  const platform = toFileOpsPlatform(hostEnv.platform);
  // Windows names variables without regard to case (`Path`).
  const lookup = (name: string): string | undefined => {
    if (platform !== 'win32') return env[name];
    const key = Object.keys(env).find((k) => k.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
  };
  return { platform, homeDir: hostEnv.homeDir, tmpDir: hostEnv.tmpDir, pathEnv: lookup('PATH'), pathExt: lookup('PATHEXT') };
}

function kindOf(stats: fs.Stats | fs.Dirent): EntryKind {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

function toFileStat(stats: fs.Stats): FileStat {
  return { kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode & 0o7777 };
}

/** The operation's own errors for the failures a caller can act on; anything else is unexpected and propagates unchanged. */
function toFileOpsError(err: unknown): unknown {
  if (err instanceof FileOpsError || !(err instanceof Error)) return err;
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT': return new FileOpsError('NOT_FOUND', err.message);
    case 'ENOTDIR': return new FileOpsError('NOT_A_DIRECTORY', err.message);
    case 'EISDIR': return new FileOpsError('NOT_A_FILE', err.message);
    case 'EEXIST': return new FileOpsError('ALREADY_EXISTS', err.message);
    case 'EACCES':
    case 'EPERM': return new FileOpsError('PERMISSION_DENIED', err.message);
    default: return err;
  }
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toFileOpsError(err);
  }
}

async function statOrNull(target: string, followLinks: boolean): Promise<fs.Stats | null> {
  try {
    return await (followLinks ? fs.promises.stat(target) : fs.promises.lstat(target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw toFileOpsError(err);
  }
}

/** The OS's own resolution (`fs.promises.realpath` is Node's JS one): it follows junctions and returns the filesystem's notation. */
const realpathNative = promisify(fs.realpath.native);

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** {@link IFileOps} with Node's `fs` on the machine this code runs on: the hub for its own (local) server, the agent for the requests it receives. */
export class LocalFileOps implements IFileOps {
  private readonly api: HostPathApi;

  constructor(private readonly host: LocalFileOpsHost) {
    this.api = pathApiFor(host.platform);
  }

  get platform(): HostPlatform {
    return this.host.platform;
  }

  private checked(input: string): string {
    const reason = invalidHostPathReason(this.host.platform, input);
    if (reason !== null) throw new FileOpsError('INVALID_PATH', `Invalid path: ${reason}`);
    return input;
  }

  async list(dir: string): Promise<DirEntry[]> {
    const target = this.checked(dir);
    return guarded(async () => {
      const items = await fs.promises.readdir(target, { withFileTypes: true });
      return Promise.all(items.map(async (item): Promise<DirEntry> => {
        const kind = kindOf(item);
        if (kind === 'directory') return { name: item.name, kind };
        // The size of what a link points at; a dangling link has none.
        const size = await fs.promises.stat(this.api.join(target, item.name)).then((s) => s.size, () => undefined);
        return size === undefined ? { name: item.name, kind } : { name: item.name, kind, size };
      }));
    });
  }

  async stat(path: string, options: { followLinks?: boolean } = {}): Promise<FileStat | null> {
    const target = this.checked(path);
    const stats = await statOrNull(target, options.followLinks !== false);
    return stats && toFileStat(stats);
  }

  async read(path: string, options: { maxBytes?: number } = {}): Promise<FileContent> {
    const target = this.checked(path);
    return guarded(async () => {
      const stats = await fs.promises.stat(target);
      if (!stats.isFile()) throw new FileOpsError('NOT_A_FILE', `Not a regular file: ${target}`);
      if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
        throw new FileOpsError('TOO_LARGE', `File too large (${stats.size} bytes, limit ${options.maxBytes})`, { size: stats.size });
      }
      return { data: await fs.promises.readFile(target), stat: toFileStat(stats) };
    });
  }

  async write(path: string, data: Buffer, options: WriteOptions = {}): Promise<WriteResult> {
    const target = this.checked(path);
    return guarded(async () => {
      const existing = await statOrNull(target, false);
      if (existing?.isSymbolicLink()) throw new FileOpsError('SYMLINK_REFUSED', 'Refusing to write through a symlink');
      if (existing && !existing.isFile()) throw new FileOpsError('NOT_A_FILE', `Not a regular file: ${target}`);
      if (options.expect) await this.assertUnchanged(target, existing, options.expect);

      // Staged next to the target (the same filesystem, so the rename is atomic), owner-only until it is complete. A new
      // file takes the process's umask like any file the host creates; an existing one keeps its permission bits.
      const staging = this.api.join(this.api.dirname(target), `.${this.api.basename(target)}.azito-tmp-${randomBytes(8).toString('hex')}`);
      try {
        const handle = await fs.promises.open(staging, 'wx', existing ? 0o600 : 0o666);
        try {
          await handle.writeFile(data);
          if (existing && this.host.platform !== 'win32') await handle.chmod(existing.mode & 0o7777);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(staging, target);
      } catch (err) {
        await fs.promises.rm(staging, { force: true }).catch(() => undefined);
        throw err;
      }
      return { mtimeMs: (await fs.promises.stat(target)).mtimeMs, sha256: sha256Of(data) };
    });
  }

  /** Fails closed: a file that is gone, or whose mtime / content differs from what the caller saw, is a conflict. */
  private async assertUnchanged(target: string, current: fs.Stats | null, expect: NonNullable<WriteOptions['expect']>): Promise<void> {
    if (!current) throw new FileOpsError('CONFLICT', 'The file no longer exists', { currentMtimeMs: null });
    const conflict = (): FileOpsError => new FileOpsError('CONFLICT', 'The file changed since it was read', { currentMtimeMs: current.mtimeMs });
    if (expect.mtimeMs !== undefined && current.mtimeMs !== expect.mtimeMs) throw conflict();
    if (expect.sha256 !== undefined && sha256Of(await fs.promises.readFile(target)) !== expect.sha256) throw conflict();
  }

  async create(path: string, kind: 'file' | 'directory', options: { recursive?: boolean } = {}): Promise<{ created: boolean }> {
    const target = this.checked(path);
    return guarded(async () => {
      if (kind === 'file') {
        await (await fs.promises.open(target, 'wx')).close();
        return { created: true };
      }
      if (!options.recursive) {
        await fs.promises.mkdir(target);
        return { created: true };
      }
      const existing = await statOrNull(target, true);
      if (existing) {
        if (!existing.isDirectory()) throw new FileOpsError('ALREADY_EXISTS', `Already exists and is not a directory: ${target}`);
        return { created: false };
      }
      await fs.promises.mkdir(target, { recursive: true });
      return { created: true };
    });
  }

  async remove(path: string): Promise<void> {
    const target = this.checked(path);
    return guarded(async () => {
      await fs.promises.lstat(target);
      await fs.promises.rm(target, { recursive: true, force: true });
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.checked(from);
    const destination = this.checked(to);
    return guarded(async () => {
      await fs.promises.lstat(source);
      if (await statOrNull(destination, false)) throw new FileOpsError('ALREADY_EXISTS', `Already exists: ${destination}`);
      await fs.promises.rename(source, destination);
    });
  }

  async realpath(path: string): Promise<string> {
    const target = this.checked(path);
    return guarded(() => realpathNative(this.expandHome(target)));
  }

  private expandHome(target: string): string {
    if (target === '~') return this.host.homeDir;
    if (target.startsWith('~/') || (this.host.platform === 'win32' && target.startsWith('~\\'))) return this.api.join(this.host.homeDir, target.slice(2));
    return target;
  }

  async which(command: string): Promise<string | null> {
    const name = this.checked(command);
    const win32 = this.host.platform === 'win32';
    const extensions = win32 ? (this.host.pathExt ?? DEFAULT_PATHEXT).split(';').filter(Boolean) : [];
    const hasKnownExtension = extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
    const withExtensions = (base: string): string[] => (win32 && !hasKnownExtension ? extensions.map((ext) => base + ext) : [base]);

    const hasSeparator = name.includes('/') || (win32 && name.includes('\\'));
    const bases = hasSeparator
      ? [name]
      : (this.host.pathEnv ?? '').split(pathDelimiterFor({ platform: this.host.platform })).filter(Boolean).map((dir) => this.api.join(dir, name));
    for (const base of bases) {
      for (const candidate of withExtensions(base)) {
        if (await this.isExecutableFile(candidate)) return candidate;
      }
    }
    return null;
  }

  private async isExecutableFile(candidate: string): Promise<boolean> {
    try {
      if (!(await fs.promises.stat(candidate)).isFile()) return false;
      if (this.host.platform !== 'win32') await fs.promises.access(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async tmpPath(prefix: string): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(prefix)) throw new FileOpsError('INVALID_PATH', `Invalid temporary file prefix: ${prefix}`);
    return this.api.join(this.host.tmpDir, `${prefix}-${randomBytes(8).toString('hex')}`);
  }
}
