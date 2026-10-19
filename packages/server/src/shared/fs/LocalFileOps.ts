import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import { promisify } from 'util';
import { KeyedMutex } from '../keyedMutex';
import type { HostEnv, HostPlatform } from '../os/hostEnv';
import { invalidHostPathReason, pathApiFor, type HostPathApi } from '../os/hostPath';
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
} from './fileOps';
import { compileGlob } from './glob';

/** What a {@link LocalFileOps} needs to know of the host it runs on, resolved once at the process's entry point. */
export interface LocalFileOpsHost {
  platform: HostPlatform;
  homeDir: string;
}

/** An OS AZITO has no profile for (freebsd...) is handled with POSIX path rules, like an agent registered before its OS was recorded. */
function toFileOpsPlatform(platform: NodeJS.Platform): HostPlatform {
  if (platform === 'win32') return 'win32';
  return platform === 'darwin' ? 'darwin' : 'linux';
}

export function localFileOpsHost(hostEnv: Pick<HostEnv, 'platform' | 'homeDir'>): LocalFileOpsHost {
  return { platform: toFileOpsPlatform(hostEnv.platform), homeDir: hostEnv.homeDir };
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

/** The first `count` bytes of a file (fewer when it is shorter). */
async function readHead(target: string, count: number): Promise<Buffer> {
  const handle = await fs.promises.open(target, 'r');
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The OS's own resolution (`fs.promises.realpath` is Node's JS one): it follows junctions and returns the filesystem's notation. */
const realpathNative = promisify(fs.realpath.native);

/**
 * Serializes, within this process, the operations that check something and then change it (a lock-checked write, a rename
 * that must not overwrite). The hub's own files and an agent's requests are each one process, so this closes the race between
 * two callers; a different process on the host can still interleave (see `rename` and `write` for what is guaranteed then).
 */
const pathLocks = new KeyedMutex();

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
        // The size and mtime of what a link points at; a dangling link has neither.
        const stats = await fs.promises.stat(this.api.join(target, item.name)).catch(() => undefined);
        return stats === undefined ? { name: item.name, kind } : { name: item.name, kind, size: stats.size, mtimeMs: stats.mtimeMs };
      }));
    });
  }

  async stat(path: string, options: { followLinks?: boolean; withAge?: boolean } = {}): Promise<FileStat | null> {
    const target = this.checked(path);
    const stats = await statOrNull(target, options.followLinks !== false);
    if (!stats) return null;
    return options.withAge ? { ...toFileStat(stats), ageMs: Date.now() - stats.mtimeMs } : toFileStat(stats);
  }

  async walk(root: string, options: WalkOptions): Promise<WalkResult> {
    const base = this.checked(root);
    const excluded = options.excludeNames.map((glob) => compileGlob(glob, true));
    const deadline = Date.now() + options.timeBudgetMs;
    const entries: WalkEntry[] = [];
    let level = [{ absolute: base, relative: '', depth: 0 }];
    while (level.length > 0) {
      const next: typeof level = [];
      for (const dir of level) {
        if (Date.now() > deadline) return { entries, truncated: true };
        let items: fs.Dirent[];
        try {
          items = await fs.promises.readdir(dir.absolute, { withFileTypes: true });
        } catch (err) {
          if (dir.absolute === base) throw toFileOpsError(err);
          continue;
        }
        items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const item of items) {
          if (excluded.some((matches) => matches(item.name))) continue;
          const relative = dir.relative === '' ? item.name : `${dir.relative}/${item.name}`;
          if (item.isDirectory()) {
            if (options.maxDepth === undefined || dir.depth < options.maxDepth) {
              next.push({ absolute: this.api.join(dir.absolute, item.name), relative, depth: dir.depth + 1 });
            }
          } else if (item.isFile()) {
            if (entries.length >= options.maxEntries) return { entries, truncated: true };
            // A file that vanished since the listing is not one.
            const stats = await fs.promises.lstat(this.api.join(dir.absolute, item.name)).catch(() => null);
            if (stats) entries.push({ path: relative, mtimeMs: stats.mtimeMs });
          }
        }
      }
      level = next;
    }
    return { entries, truncated: false };
  }

  /**
   * `target` is renamed to a backup beside it, `staging` to `target`, and only then is the backup removed. If the second rename
   * fails, the backup goes back (and if even that fails the error says where the old tree is). Removing the backup afterwards is
   * best-effort: the replacement has already happened.
   */
  async replaceDirectory(staging: string, target: string): Promise<void> {
    const from = this.checked(staging);
    const to = this.checked(target);
    return this.withPathLocks([from, to], () => guarded(async () => {
      if (!(await fs.promises.lstat(from)).isDirectory()) throw new FileOpsError('NOT_A_DIRECTORY', `Not a directory: ${from}`);
      const existing = await statOrNull(to, false);
      if (existing === null) {
        await fs.promises.rename(from, to);
        return;
      }
      const backup = this.api.join(this.api.dirname(to), `.${this.api.basename(to)}.azito-old-${randomBytes(8).toString('hex')}`);
      await fs.promises.rename(to, backup);
      try {
        await fs.promises.rename(from, to);
      } catch (err) {
        try {
          await fs.promises.rename(backup, to);
        } catch (restoreError) {
          throw new AggregateError([err, restoreError], `Could not replace ${to}, and could not put it back; the previous content is at ${backup}`);
        }
        throw err;
      }
      await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }));
  }

  async read(path: string, options: { maxBytes?: number; headBytes?: number } = {}): Promise<FileContent> {
    const target = this.checked(path);
    return guarded(async () => {
      const stats = await fs.promises.stat(target);
      if (!stats.isFile()) throw new FileOpsError('NOT_A_FILE', `Not a regular file: ${target}`);
      if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
        throw new FileOpsError('TOO_LARGE', `File too large (${stats.size} bytes, limit ${options.maxBytes})`, { size: stats.size });
      }
      if (options.headBytes !== undefined) return { data: await readHead(target, options.headBytes), stat: toFileStat(stats) };
      return { data: await fs.promises.readFile(target), stat: toFileStat(stats) };
    });
  }

  async write(path: string, data: Buffer, options: WriteOptions = {}): Promise<WriteResult> {
    const target = this.checked(path);
    // The check of the lock and the replace are one step as far as other callers of this process are concerned.
    return this.withPathLocks([target], () => guarded(async () => {
      const existing = await statOrNull(target, false);
      if (existing?.isSymbolicLink()) throw new FileOpsError('SYMLINK_REFUSED', 'Refusing to write through a symlink');
      if (existing && !existing.isFile()) throw new FileOpsError('NOT_A_FILE', `Not a regular file: ${target}`);
      // A file that may not be written is not replaced either (a rename would get past its permission bits).
      if (existing) await fs.promises.access(target, fs.constants.W_OK);
      if (options.expect) await this.assertUnchanged(target, existing, options.expect);

      if (existing && this.host.platform === 'win32') {
        await this.writeInPlace(target, data);
      } else {
        await this.replaceAtomically(target, data, existing);
      }
      return { mtimeMs: (await fs.promises.stat(target)).mtimeMs, sha256: sha256Of(data) };
    }));
  }

  /**
   * Windows: a replaced file loses its explicit ACL (the new file gets the folder's), so an existing file is rewritten where it
   * is. That is not atomic (a crash mid-write leaves a partial file); keeping the ACL was chosen over atomicity here.
   */
  private async writeInPlace(target: string, data: Buffer): Promise<void> {
    const handle = await fs.promises.open(target, 'r+');
    try {
      await handle.truncate(0);
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Staged next to the target (the same filesystem, so the rename is atomic) and owner-only until it is complete. A new file takes
   * the process's umask like any file the host creates; an existing one keeps its permission bits, owner and group. If the owner
   * or group cannot be kept (another user's file), nothing is changed and the write fails. Extended attributes / POSIX ACLs of
   * the old file are not copied.
   */
  private async replaceAtomically(target: string, data: Buffer, existing: fs.Stats | null): Promise<void> {
    const staging = this.api.join(this.api.dirname(target), `.${this.api.basename(target)}.azito-tmp-${randomBytes(8).toString('hex')}`);
    try {
      const handle = await fs.promises.open(staging, 'wx', existing ? 0o600 : 0o666);
      try {
        await handle.writeFile(data);
        if (existing) {
          const created = await handle.stat();
          if (created.uid !== existing.uid || created.gid !== existing.gid) {
            await handle.chown(existing.uid, existing.gid).catch((err: NodeJS.ErrnoException) => {
              if (err.code === 'EPERM') throw new FileOpsError('PERMISSION_DENIED', `Cannot keep the owner and group of ${target}; the file was not changed`);
              throw err;
            });
          }
          await handle.chmod(existing.mode & 0o7777);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(staging, target);
    } catch (err) {
      await fs.promises.rm(staging, { force: true }).catch(() => undefined);
      throw err;
    }
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
    // "." and ".." as the last element name something other than the path that was checked (the parent of the root, or `.git`
    // on Windows): never a thing to remove.
    const last = this.api.basename(target);
    if (last === '.' || last === '..') throw new FileOpsError('INVALID_PATH', `Invalid path: cannot remove "${last}"`);
    return guarded(async () => {
      await fs.promises.lstat(target);
      await fs.promises.rm(target, { recursive: true, force: true });
    });
  }

  /**
   * Moves without overwriting. Callers of this process are serialized per destination, so the second of two moves to the same
   * name is `ALREADY_EXISTS`. Against another process: a regular file on Unix is moved with `link` then `unlink`, and `link`
   * refuses an existing name atomically; a directory, a link, and anything on Windows (whose rename replaces a file), are checked and
   * then renamed, so another process creating the destination in between can still be overwritten there.
   */
  async rename(from: string, to: string): Promise<void> {
    const source = this.checked(from);
    const destination = this.checked(to);
    return this.withPathLocks([source, destination], () => guarded(async () => {
      const moving = await fs.promises.lstat(source);
      if (await statOrNull(destination, false)) throw new FileOpsError('ALREADY_EXISTS', `Already exists: ${destination}`);
      // Only a regular file takes the link route: on macOS `link` follows a symbolic link and would link what it points at.
      if (this.host.platform !== 'win32' && moving.isFile()) {
        if (await this.moveByLink(source, destination)) return;
      }
      await fs.promises.rename(source, destination);
    }));
  }

  /**
   * `link` then `unlink`: `link` refuses an existing name atomically. Returns false when `link` itself cannot be used here (no
   * hard links on the filesystem, another filesystem), so the caller renames instead; only `link` failing decides that. If the
   * source cannot be unlinked after the link was made, the destination is removed again and the original error is thrown
   * (with the failure of that undo, if any): a rename that leaves both names is never reported as done.
   */
  private async moveByLink(source: string, destination: string): Promise<boolean> {
    try {
      await fs.promises.link(source, destination);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new FileOpsError('ALREADY_EXISTS', `Already exists: ${destination}`);
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'EMLINK' || code === 'ENOSYS') return false;
      throw err;
    }
    try {
      await fs.promises.unlink(source);
    } catch (unlinkError) {
      try {
        await fs.promises.unlink(destination);
      } catch (undoError) {
        throw new AggregateError([unlinkError, undoError], `Could not remove ${source} after linking it to ${destination}, and could not undo the link; both names now exist`);
      }
      throw unlinkError;
    }
    return true;
  }

  /**
   * Runs `fn` while holding a lock for each path (taken in sorted order, so two callers cannot wait on each other). A lock is
   * named by the parent directory's real path and the name, folded to lower case where the filesystem usually ignores case
   * (win32, darwin): the same file spelled differently is one lock, and folding too much only serializes more.
   */
  private async withPathLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    const foldCase = this.host.platform !== 'linux';
    const keys = await Promise.all(paths.map(async (p) => {
      const parent = this.api.dirname(p);
      const realParent = await realpathNative(parent).catch(() => parent);
      const key = this.api.join(realParent, this.api.basename(p));
      return foldCase ? key.toLowerCase() : key;
    }));
    const sorted = [...new Set(keys)].sort();
    const run = (i: number): Promise<T> => (i === sorted.length ? fn() : pathLocks.withLock(sorted[i], () => run(i + 1)));
    return run(0);
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
}
