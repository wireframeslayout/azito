import { FileOpsError, type IFileOps, type WalkEntry } from '../../shared/fs/fileOps';
import { compileGlob, compileIncludeFilter } from '../../shared/fs/glob';
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

/** Why a search root has nothing to search: not an error of the search. */
export const NOTHING_TO_SEARCH: ReadonlySet<FileOpsError['code']> = new Set(['NOT_FOUND', 'NOT_A_DIRECTORY', 'PERMISSION_DENIED']);

function depthOf(path: string): number {
  let depth = 0;
  for (let i = 0; i < path.length; i++) if (path[i] === '/') depth++;
  return depth;
}

/** Entries examined between two looks at the clock; the event loop gets a turn each time. */
const MATCH_CHUNK = 2_000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The entries `keep` accepts, shallower first and by name within a level, up to `limit`. The depth of each path is worked out once
 * (one pass), and a level is sorted only when it is reached, so a search that finds its `limit` among the shallow files never sorts
 * the deep ones. Between chunks the event loop runs and the deadline is checked: past it, what was kept so far is returned.
 */
async function filterInOrder(entries: WalkEntry[], keep: (entry: WalkEntry) => boolean, limit: number, deadlineAtMs: number): Promise<{ kept: WalkEntry[]; timedOut: boolean }> {
  const levels: WalkEntry[][] = [];
  for (const entry of entries) (levels[depthOf(entry.path)] ??= []).push(entry);
  const kept: WalkEntry[] = [];
  for (const level of levels) {
    if (!level) continue;
    level.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (let start = 0; start < level.length; start += MATCH_CHUNK) {
      if (Date.now() > deadlineAtMs) return { kept, timedOut: true };
      for (const entry of level.slice(start, start + MATCH_CHUNK)) {
        if (!keep(entry)) continue;
        kept.push(entry);
        if (kept.length >= limit) return { kept, timedOut: false };
      }
      await yieldToEventLoop();
    }
  }
  return { kept, timedOut: false };
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

  const rootPrefix = search.root.replace(/[\\/]+$/, '');
  const isIncluded = compileIncludeFilter(search.root, search.include);
  const nameOf = (entry: WalkEntry): string => entry.path.slice(entry.path.lastIndexOf('/') + 1);
  const included = (entry: WalkEntry): boolean => isIncluded(entry.path);

  if (!search.regex) {
    const contains = compileGlob(`*${search.query}*`, search.caseSensitive);
    const { kept, timedOut } = await filterInOrder(walked.entries, (entry) => included(entry) && contains(nameOf(entry)), limits.maxResults, deadline);
    return { paths: kept.map((entry) => entry.path), truncated: walked.truncated || timedOut };
  }

  const { kept: candidates, timedOut: listingTimedOut } = await filterInOrder(walked.entries, included, Infinity, deadline);
  if (listingTimedOut) return { paths: [], truncated: true };
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
