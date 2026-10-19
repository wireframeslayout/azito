import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { pathApiFor } from '../../shared/os/hostPath';

/** A regular file found by {@link findFilesByMtime}. */
export interface ScannedFile {
  path: string;
  mtimeMs: number;
}

/**
 * The regular files below `dir` (any depth, symbolic links not followed) whose name `matchesName` accepts and whose mtime is
 * after `afterTimestamp` (whole seconds, strictly newer), oldest first. A directory that is missing or cannot be read yields
 * nothing, as the `find ... 2>/dev/null` this replaces did. Any other failure (an unreachable agent) propagates.
 */
export async function findFilesByMtime(
  files: IFileOps,
  dir: string,
  matchesName: (name: string) => boolean,
  afterTimestamp?: Date,
): Promise<ScannedFile[]> {
  const api = pathApiFor(files.platform);
  const newerThanMs = afterTimestamp ? Math.floor(afterTimestamp.getTime() / 1000) * 1000 : null;
  const found: ScannedFile[] = [];
  const scan = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await files.list(current);
    } catch (err) {
      if (err instanceof FileOpsError) return;
      throw err;
    }
    for (const entry of entries) {
      const full = api.join(current, entry.name);
      if (entry.kind === 'directory') {
        await scan(full);
      } else if (entry.kind === 'file' && matchesName(entry.name)) {
        if (entry.mtimeMs === undefined) {
          throw new Error(`The host listed ${full} without a modification time (an outdated agent?)`);
        }
        if (newerThanMs === null || entry.mtimeMs > newerThanMs) found.push({ path: full, mtimeMs: entry.mtimeMs });
      }
    }
  };
  await scan(dir);
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
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

export function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}
