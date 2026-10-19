import { FileOpsError, type IFileOps, type WalkEntry } from '../../shared/fs/fileOps';
import { compileGlob } from '../../shared/fs/glob';
import { DeadlineExceededError, raceDeadline } from '../../shared/fs/deadline';
import { matchWithRegex } from './regexMatchWorker';

/** What a file-name search looks for. The patterns are already split (one glob per element). */
export interface NameSearchQuery {
  /** The directory searched, in the host's notation. */
  root: string;
  query: string;
  caseSensitive: boolean;
  /** `query` is a regular expression (JavaScript syntax) that must match the whole path (`root` + `/` + relative path). */
  regex: boolean;
  /** Globs a file must match (any of them): its name, or its whole path preceded by `*` and `/` for a glob that has a `/`. Empty: every file. */
  include: string[];
  /** Globs of entry names that are neither listed nor entered, at any depth. */
  excludeNames: string[];
}

export interface NameSearchLimits {
  maxResults: number;
  /** Everything (the walk on the host and the matching) has to be done within this time. */
  budgetMs: number;
}

export interface NameSearchResult {
  /** Relative to the root, always with `/`: shallower first, by name within a level. */
  paths: string[];
  /** The tree was not seen whole (the walk reached its file or time bound, or the time ran out while matching). */
  truncated: boolean;
}

/** Files one walk returns at most. A tree with more is searched only as far as this. */
export const NAME_SEARCH_MAX_FILES = 200_000;
/** Kept back from the budget for the answer of the host to come back, and for the matching. */
const WALK_RESERVE_MS = 1_500;

const NOTHING_TO_SEARCH: ReadonlySet<FileOpsError['code']> = new Set(['NOT_FOUND', 'NOT_A_DIRECTORY', 'PERMISSION_DENIED']);

function depthOf(path: string): number {
  let depth = 0;
  for (let i = 0; i < path.length; i++) if (path[i] === '/') depth++;
  return depth;
}

/** Shallower first, then by name: the same order whether the host walked level by level or in `find`'s order. */
function byDepthThenName(a: WalkEntry, b: WalkEntry): number {
  return depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * The regular files below `search.root` whose name matches, found by one walk on the host (`IFileOps.walk`, one request however
 * large the tree) and matched here. A search that runs out of time, or whose tree is larger than the walk allows, returns what it
 * has with `truncated`. The patterns come from a user: globs are matched without regular expressions (`compileGlob`), and a
 * regular expression only in a worker thread that the deadline can terminate. A root that is missing or unreadable has no files;
 * any other failure (an unreachable agent) propagates.
 */
export async function searchFileNames(files: IFileOps, search: NameSearchQuery, limits: NameSearchLimits): Promise<NameSearchResult> {
  const deadline = Date.now() + limits.budgetMs;
  let walked;
  try {
    walked = await raceDeadline(files.walk(search.root, {
      excludeNames: search.excludeNames,
      maxEntries: NAME_SEARCH_MAX_FILES,
      timeBudgetMs: Math.max(1, limits.budgetMs - WALK_RESERVE_MS),
    }), deadline, 'The file name walk');
  } catch (err) {
    if (err instanceof DeadlineExceededError) return { paths: [], truncated: true };
    if (err instanceof FileOpsError && NOTHING_TO_SEARCH.has(err.code)) return { paths: [], truncated: false };
    throw err;
  }

  const rootPrefix = search.root.replace(/\/+$/, '');
  const includes = search.include.map((glob) => (glob.includes('/')
    ? { onPath: true, matches: compileGlob(`*/${glob}`, true) }
    : { onPath: false, matches: compileGlob(glob, true) }));
  const candidates = walked.entries.sort(byDepthThenName).filter((entry) => {
    const fullPath = `${rootPrefix}/${entry.path}`;
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    return includes.length === 0 || includes.some((include) => include.matches(include.onPath ? fullPath : name));
  });

  if (!search.regex) {
    const contains = compileGlob(`*${search.query}*`, search.caseSensitive);
    const paths: string[] = [];
    for (const entry of candidates) {
      if (contains(entry.path.slice(entry.path.lastIndexOf('/') + 1))) paths.push(entry.path);
      if (paths.length >= limits.maxResults) break;
    }
    return { paths, truncated: walked.truncated };
  }

  const found = await matchWithRegex({
    pattern: `^(?:${search.query})$`,
    flags: search.caseSensitive ? 's' : 'si',
    texts: candidates.map((entry) => `${rootPrefix}/${entry.path}`),
    maxMatches: limits.maxResults,
    timeoutMs: deadline - Date.now(),
  });
  if (found.invalid) return { paths: [], truncated: false };
  return { paths: found.matched.map((index) => candidates[index].path), truncated: walked.truncated || found.timedOut };
}
