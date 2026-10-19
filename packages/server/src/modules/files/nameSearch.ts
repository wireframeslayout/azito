import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { pathApiFor } from '../../shared/os/hostPath';

/** What a file-name search looks for. The patterns are already split (one glob per element). */
export interface NameSearchQuery {
  /** The directory searched, in the host's notation. */
  root: string;
  query: string;
  caseSensitive: boolean;
  /** `query` is a regular expression that must match the whole path (`root` + `/` + relative path), like `find -regex`. */
  regex: boolean;
  /** Globs a file must match (any of them): `find -name`, or `find -path` with a leading wildcard and slash for one that has a `/`. Empty: every file. */
  include: string[];
  /** Globs of entry names that are neither listed nor entered (`find -name <glob> -prune`). */
  excludeNames: string[];
}

export interface NameSearchLimits {
  maxResults: number;
  /** The search ends with `NameSearchTimeoutError` once this instant has passed. */
  deadlineMs: number;
}

export class NameSearchTimeoutError extends Error {
  constructor() {
    super('The file name search ran past its deadline');
    this.name = 'NameSearchTimeoutError';
  }
}

/** Directories listed at once. A remote host answers each listing with a request, so one at a time would be slow on a large tree. */
const LISTING_CONCURRENCY = 8;

/**
 * A glob as `find -name` / `-path` read it: `*` (any characters, `/` included), `?`, `[set]` / `[!set]` and a backslash that
 * takes the next character literally. Anything else is itself.
 */
export function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else if (char === '\\' && i + 1 < glob.length) {
      source += escapeRegExp(glob[++i]);
    } else if (char === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) {
        source += '\\[';
      } else {
        const set = glob.slice(i + 1, close);
        const negated = set.startsWith('!') || set.startsWith('^');
        source += `[${negated ? '^' : ''}${(negated ? set.slice(1) : set).replace(/[\\\]^]/g, '\\$&')}]`;
        i = close;
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, caseSensitive ? 's' : 'si');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

interface Matchers {
  isExcluded(name: string): boolean;
  isMatch(name: string, fullPath: string): boolean;
}

/** Null when `query` is a regular expression JavaScript cannot compile: nothing can match it. */
function buildMatchers(search: NameSearchQuery): Matchers | null {
  const excluded = search.excludeNames.map((glob) => globToRegExp(glob, true));
  const includes = search.include.map((glob) => (glob.includes('/')
    ? { onPath: true, pattern: globToRegExp(`*/${glob}`, true) }
    : { onPath: false, pattern: globToRegExp(glob, true) }));
  let queryMatcher: (name: string, fullPath: string) => boolean;
  if (search.regex) {
    let whole: RegExp;
    try {
      whole = new RegExp(`^(?:${search.query})$`, search.caseSensitive ? 's' : 'si');
    } catch {
      return null;
    }
    queryMatcher = (_name, fullPath) => whole.test(fullPath);
  } else {
    const contains = globToRegExp(`*${search.query}*`, search.caseSensitive);
    queryMatcher = (name) => contains.test(name);
  }
  return {
    isExcluded: (name) => excluded.some((pattern) => pattern.test(name)),
    isMatch: (name, fullPath) =>
      (includes.length === 0 || includes.some((i) => i.pattern.test(i.onPath ? fullPath : name))) && queryMatcher(name, fullPath),
  };
}

/**
 * The regular files below `search.root` whose name matches, as paths relative to the root (always with `/`), shallower first and
 * by name within a level. Walks the tree
 * with `IFileOps.list`, a level at a time: symbolic links are neither followed nor listed, an excluded name is skipped
 * wherever it is, and a directory that cannot be listed is passed over (the unreadable parts of a tree are not an error of a
 * search). Stops at `maxResults`, and with `NameSearchTimeoutError` at the deadline. A failure that is not a
 * `FileOpsError` (an unreachable agent) propagates.
 */
export async function searchFileNames(files: IFileOps, search: NameSearchQuery, limits: NameSearchLimits): Promise<string[]> {
  const matchers = buildMatchers(search);
  if (!matchers) return [];
  const api = pathApiFor(files.platform);
  const rootPrefix = search.root.replace(/\/+$/, '');
  const results: string[] = [];

  const listOrNothing = async (dir: string): Promise<{ name: string; kind: string }[]> => {
    try {
      return (await files.list(dir)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      if (err instanceof FileOpsError) return [];
      throw err;
    }
  };

  let level = [{ absolute: search.root, relative: '' }];
  while (level.length > 0 && results.length < limits.maxResults) {
    const next: typeof level = [];
    for (let i = 0; i < level.length && results.length < limits.maxResults; i += LISTING_CONCURRENCY) {
      if (Date.now() > limits.deadlineMs) throw new NameSearchTimeoutError();
      const batch = level.slice(i, i + LISTING_CONCURRENCY);
      const listings = await Promise.all(batch.map((dir) => listOrNothing(dir.absolute)));
      batch.forEach((dir, index) => {
        for (const entry of listings[index]) {
          if (matchers.isExcluded(entry.name)) continue;
          const relative = dir.relative === '' ? entry.name : `${dir.relative}/${entry.name}`;
          if (entry.kind === 'directory') {
            next.push({ absolute: api.join(dir.absolute, entry.name), relative });
          } else if (entry.kind === 'file' && results.length < limits.maxResults && matchers.isMatch(entry.name, `${rootPrefix}/${relative}`)) {
            results.push(relative);
          }
        }
      });
    }
    level = next;
  }
  return results;
}
