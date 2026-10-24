import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { pathApiFor } from '../../shared/os/hostPath';
import type { HostPlatform } from '../../shared/os/hostEnv';
import { DeadlineExceededError, raceDeadline } from '../../shared/fs/deadline';

/** A regular file found by {@link findFilesByMtime}. */
export interface ScannedFile {
  path: string;
  mtimeMs: number;
}

/** Everything one session scan does (the walk, and the reads of the candidates) has to be done in this time. */
export const SESSION_SCAN_BUDGET_MS = 20_000;
/** Files one scan walks at most; more is an error rather than a guess from a part of the tree. */
const SESSION_SCAN_MAX_FILES = 200_000;

/**
 * The regular files below `dir` (any depth, symbolic links not followed) whose name `matchesName` accepts and whose mtime is
 * after `afterTimestamp` (whole seconds, strictly newer), oldest first. The tree is walked by the host in one request. A
 * directory that is missing or cannot be read yields nothing, as the `find ... 2>/dev/null` this replaces did. A tree that was
 * not seen whole (too many files, or past `deadlineAtMs`) is an error: the newest session could be in the part not seen.
 */
export async function findFilesByMtime(
  files: IFileOps,
  dir: string,
  matchesName: (name: string) => boolean,
  afterTimestamp: Date | undefined,
  deadlineAtMs: number,
): Promise<ScannedFile[]> {
  const api = pathApiFor(files.platform);
  const newerThanMs = afterTimestamp ? Math.floor(afterTimestamp.getTime() / 1000) * 1000 : null;
  let walked;
  try {
    walked = await raceDeadline(files.walk(dir, {
      excludeNames: [],
      maxEntries: SESSION_SCAN_MAX_FILES,
      timeBudgetMs: Math.max(1, deadlineAtMs - Date.now()),
    }), deadlineAtMs, `The session scan of ${dir}`);
  } catch (err) {
    if (err instanceof FileOpsError) return [];
    throw err;
  }
  if (walked.truncated) throw new DeadlineExceededError(`The session scan of ${dir} (more than ${SESSION_SCAN_MAX_FILES} files, or too slow)`);
  return walked.entries
    .filter((entry) => matchesName(entry.path.slice(entry.path.lastIndexOf('/') + 1)) && (newerThanMs === null || entry.mtimeMs > newerThanMs))
    .map((entry) => ({ path: api.join(dir, ...entry.path.split('/')), mtimeMs: entry.mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export interface RolloutCandidate {
  filePath: string;
  sessionId: string;
  cwd: string | null;
  originator: string | null;
}

/** How much of a rollout file is read to get its first line (the `session_meta` record); a longer first line is not a usable one. */
export const ROLLOUT_HEAD_BYTES = 256 * 1024;

/** The first line of `head`, or null when it holds none (an empty file). */
export function firstLineOf(head: Buffer): string | null {
  const text = head.toString('utf8');
  const end = text.indexOf('\n');
  const line = end === -1 ? text : text.slice(0, end);
  return line === '' ? null : line;
}

/** The session metadata in a rollout file's first line, or null when it is not a record with a session id. */
export function parseRolloutMeta(filePath: string, firstLine: string): RolloutCandidate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const payload = (parsed as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const meta = payload as { session_id?: unknown; cwd?: unknown; originator?: unknown };
  if (typeof meta.session_id !== 'string' || !meta.session_id) return null;
  return {
    filePath,
    sessionId: meta.session_id,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    originator: typeof meta.originator === 'string' ? meta.originator : null,
  };
}

/**
 * A working directory in the form two spellings of it can be compared in, by the rules of the host's OS: trailing separators
 * dropped (a root keeps its own). On win32 also `/` = `\` and letters compared without case (NTFS is case-insensitive; a
 * case-sensitive directory is rare enough that a false match is the lesser evil for picking a session). POSIX is exact.
 */
export function normalizeCwd(platform: HostPlatform, p: string): string {
  if (platform !== 'win32') {
    const root = p.startsWith('/') ? '/' : '';
    return root + p.slice(root.length).replace(/\/+$/, '');
  }
  const unified = p.replace(/\//g, '\\');
  const root = pathApiFor(platform).parse(unified).root;
  return (root + unified.slice(root.length).replace(/\\+$/, '')).toLowerCase();
}
