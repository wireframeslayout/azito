import type { HostPlatform } from '../os/hostEnv';

/**
 * File operations on the host that owns the files: Node's `fs` there, the same code on every OS (the hub for a local
 * server, the agent for an agent server). Paths are strings in the host's own notation (see `pathApiFor`); there is no
 * shell, no `find`, no `stat -c`. Every method refuses a path `invalidHostPathReason` rejects with `INVALID_PATH`.
 */
export interface IFileOps {
  /** Whose path rules the host uses. An agent registered before its OS was recorded is a Unix one (`linux`). */
  readonly platform: HostPlatform;

  /** The entries of a directory, unordered, without `.` and `..`. */
  list(dir: string): Promise<DirEntry[]>;
  /**
   * What is at `path`, or null when nothing is. Follows symbolic links unless `followLinks` is false. With `withAge`, the result
   * carries `ageMs`: how long ago it was modified by the host's own clock (so it can be compared with a duration, e.g. a lock's
   * timeout, whatever the clock of the caller says).
   */
  stat(path: string, options?: { followLinks?: boolean; withAge?: boolean }): Promise<FileStat | null>;
  /**
   * The content of a regular file with its stat. A file larger than `maxBytes` is `TOO_LARGE` (nothing is read). With
   * `headBytes` only the first `headBytes` bytes (fewer for a shorter file) are read, however large the file is; `stat` is
   * still the whole file's.
   */
  read(path: string, options?: { maxBytes?: number; headBytes?: number }): Promise<FileContent>;
  /**
   * Replaces the content of a file atomically (a temporary file in the same directory, then a rename), creating it when it
   * is missing. An existing file keeps its permission bits. Writing through a symbolic link is `SYMLINK_REFUSED`: the link's
   * own real path is what to write. With `expect`, the current mtime / sha256 must match or nothing is written (`CONFLICT`).
   */
  write(path: string, data: Buffer, options?: WriteOptions): Promise<WriteResult>;
  /** Creates a file (empty) or a directory. An existing entry is `ALREADY_EXISTS`, except that `recursive` accepts an existing directory. */
  create(path: string, kind: 'file' | 'directory', options?: { recursive?: boolean }): Promise<{ created: boolean }>;
  /** Removes a file, or a directory with everything in it. A missing path is `NOT_FOUND`. Never follows a symbolic link. */
  remove(path: string): Promise<void>;
  /** Moves `from` to `to` in the same filesystem. A missing source is `NOT_FOUND`, an existing destination `ALREADY_EXISTS`. */
  rename(from: string, to: string): Promise<void>;
  /**
   * Replaces the directory `target` (or nothing, when it does not exist) with the directory `staging`, as one operation on the
   * host. `target` is moved aside first and removed only after `staging` has taken its place; if that fails, `target` is put
   * back, so a tree that worked is never lost to a replacement that did not. A missing `staging` is `NOT_FOUND`.
   */
  replaceDirectory(staging: string, target: string): Promise<void>;
  /**
   * The regular files below the directory `root`, found by one walk on the host (one request for a remote host, however large the
   * tree). Symbolic links are neither followed nor listed. See {@link WalkOptions} for what bounds the walk; when a bound is
   * reached the files found so far are returned with `truncated`. A `root` that is missing or not a directory is `NOT_FOUND` /
   * `NOT_A_DIRECTORY`; a directory below it that cannot be read is passed over.
   */
  walk(root: string, options: WalkOptions): Promise<WalkResult>;
  /** The real path of an existing entry (symbolic links and junctions followed, notation made the filesystem's own). A leading `~` is the host's home directory. */
  realpath(path: string): Promise<string>;
}

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface DirEntry {
  name: string;
  /** What the entry itself is (a symbolic link is `symlink`, whatever it points at). */
  kind: EntryKind;
  /** Size in bytes of what a non-directory entry points at; absent for a directory or when it cannot be read (a dangling link). */
  size?: number;
  /** Modification time of what a non-directory entry points at; absent for a directory or when it cannot be read (a dangling link). */
  mtimeMs?: number;
}

export interface WalkOptions {
  /** Globs (see `compileGlob`) of entry names that are neither listed nor entered, at any depth. Case-sensitive. */
  excludeNames: string[];
  /** The walk stops after this many files. */
  maxEntries: number;
  /** Directory levels entered below `root` (0: only the files directly in `root`). Unlimited when absent. */
  maxDepth?: number;
  /** The walk stops after this long, by the host's clock. */
  timeBudgetMs: number;
}

export interface WalkEntry {
  /** Relative to the walked root, always with `/`. */
  path: string;
  mtimeMs: number;
}

export interface WalkResult {
  /** Level by level (shallower first), by name within a directory, where the host walks that way. */
  entries: WalkEntry[];
  /** A bound was reached before the whole tree was seen. */
  truncated: boolean;
}

export interface FileStat {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  /** Permission bits (`mode & 0o7777`). */
  mode: number;
  /** Only when asked for (`withAge`): milliseconds since the last modification, by the host's clock. */
  ageMs?: number;
}

export interface FileContent {
  data: Buffer;
  stat: FileStat;
}

export interface WriteOptions {
  /** Optimistic lock: the write happens only if the file still has this mtime (exact) and / or content hash (sha256, hex). */
  expect?: { mtimeMs?: number; sha256?: string };
}

export interface WriteResult {
  mtimeMs: number;
  sha256: string;
}

export type FileOpsErrorCode =
  | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_FILE'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'TOO_LARGE'
  | 'CONFLICT'
  | 'SYMLINK_REFUSED'
  | 'INVALID_PATH'
  | 'FAILED';

export interface FileOpsErrorDetails {
  /** TOO_LARGE: the size of the file. */
  size?: number;
  /** CONFLICT: the mtime the file has now (null: it could not be read). */
  currentMtimeMs?: number | null;
  /** CONFLICT: the hash could not be computed, so the lock could not be checked (it fails closed). */
  hashUnavailable?: boolean;
}

/** An operation that did not happen for a reason the caller can act on. Anything else is an unexpected error and propagates as it is. */
export class FileOpsError extends Error {
  constructor(readonly code: FileOpsErrorCode, message: string, readonly details: FileOpsErrorDetails = {}) {
    super(message);
    this.name = 'FileOpsError';
  }
}
