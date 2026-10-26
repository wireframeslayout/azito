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
  /**
   * The lines of the regular files below the directory `root` that match a query, searched on the host by AZITO's own code
   * (no `rg` / `grep` needed). The tree is walked like {@link IFileOps.walk}; a file that looks binary (a NUL byte) or is larger than
   * {@link CONTENT_SEARCH_MAX_FILE_BYTES} is passed over (a file that starts with a byte order mark is text in UTF-8 or UTF-16). See {@link ContentSearchOptions} for the bounds; when one is reached the
   * hits found so far are returned with `truncated`. A `root` that is missing or not a directory is `NOT_FOUND` / `NOT_A_DIRECTORY`.
   * An expression that cannot be compiled has no hits.
   */
  searchContent(root: string, options: ContentSearchOptions): Promise<ContentSearchResult>;
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

/** Files larger than this are not searched by {@link IFileOps.searchContent} (a minified bundle or a data dump is not what a person searches for). */
export const CONTENT_SEARCH_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The text of all the hits of one search together stops at this size (the 1 MB the output of `rg` / `grep` is cut at). */
export const CONTENT_SEARCH_MAX_RESULT_BYTES = 1024 * 1024;
/** The text of a hit is at most this many characters: a longer line is cut to a window around the match. */
export const CONTENT_SEARCH_MAX_LINE_CHARS = 2000;
/** A file yields at most this many matching lines (ripgrep is run with `--max-count 5` the same way). */
export const CONTENT_SEARCH_MAX_HITS_PER_FILE = 5;

export interface ContentSearchOptions {
  query: string;
  caseSensitive: boolean;
  /** The match has to be a whole word: no letter, digit or `_` of the ASCII range next to it. */
  wholeWord: boolean;
  /** `query` is a regular expression (JavaScript syntax) that is matched against each line; otherwise it is text. */
  regex: boolean;
  /** Globs a file must match (any of them), read as ripgrep's `-g` reads them (see `compileSearchPathFilter`): a name at any depth, or with a `/` a path from `root`. Empty: every file. */
  include: string[];
  /** Globs of files and directories that are left out (`-g '!glob'`), read the same way; a directory that matches is not entered. Case-sensitive. */
  exclude: string[];
  /** The search stops after this many hits. */
  maxHits: number;
  /** The search stops after this long, by the host's clock. */
  timeBudgetMs: number;
}

export interface ContentSearchHit {
  /** Relative to the searched root, always with `/`. */
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 units. */
  column: number;
  /** The line, without its line terminator (`\n` or `\r\n`); a line longer than {@link CONTENT_SEARCH_MAX_LINE_CHARS} is cut to a window around the match. */
  text: string;
  /** Offsets of the first match in `text`, in UTF-16 units (in the window, for a cut line). */
  matchStart: number;
  matchEnd: number;
}

export interface ContentSearchResult {
  /** By file (shallower first, by name within a level), by line within a file. */
  hits: ContentSearchHit[];
  /** A bound was reached before every file was searched. */
  truncated: boolean;
  /** The time ran out in the middle of the search (it is also `truncated`): with no hits, nothing was learned. */
  timedOut: boolean;
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
  /**
   * A file that does not exist yet is created readable by its owner only (0600) from the first moment, whatever the umask; an existing
   * file keeps its permission bits. On Windows there are no such bits: the file takes the ACL of its folder (the user's own temp folder
   * is not readable by other users by default).
   */
  ownerOnly?: boolean;
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
