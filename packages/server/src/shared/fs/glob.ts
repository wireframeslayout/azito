/**
 * Shell-style globs (`find -name` / `-path`) matched without a regular expression: `*` (any characters, `/` included), `?`,
 * `[set]` / `[!set]` (ranges allowed) and a backslash that takes the next character literally. Anything else is itself.
 *
 * The match is the iterative algorithm that backtracks only to the last `*`, so it takes O(pattern x text) at worst. A glob
 * comes from a user (a search query, an include / exclude list) and is matched on the hub and on agents, so it must not be able
 * to run for exponential time the way the same text compiled to a regular expression could.
 */
type GlobToken =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'char'; char: string }
  | { kind: 'set'; negated: boolean; singles: string; ranges: [string, string][] };

function parseGlob(glob: string, fold: (text: string) => string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (char === '?') {
      tokens.push({ kind: 'any' });
    } else if (char === '\\' && i + 1 < glob.length) {
      tokens.push({ kind: 'char', char: fold(glob[++i]) });
    } else if (char === '[' && glob.indexOf(']', i + 2) !== -1) {
      const close = glob.indexOf(']', i + 2);
      let body = glob.slice(i + 1, close);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      const set: GlobToken = { kind: 'set', negated, singles: '', ranges: [] };
      for (let j = 0; j < body.length; j++) {
        if (j + 2 < body.length && body[j + 1] === '-') {
          set.ranges.push([fold(body[j]), fold(body[j + 2])]);
          j += 2;
        } else {
          set.singles += fold(body[j]);
        }
      }
      tokens.push(set);
      i = close;
    } else {
      tokens.push({ kind: 'char', char: fold(char) });
    }
  }
  return tokens;
}

function matchesOne(token: GlobToken, char: string): boolean {
  switch (token.kind) {
    case 'any': return true;
    case 'char': return token.char === char;
    case 'set': {
      const inSet = token.singles.includes(char) || token.ranges.some(([from, to]) => char >= from && char <= to);
      return inSet !== token.negated;
    }
    case 'star': return false;
  }
}

/**
 * Lower case, one UTF-16 unit at a time, and a unit whose lower case is not a single unit (`İ` becomes `i` + a combining dot) is
 * left as it is: the text keeps its length, and the comparison is per character like the `i` flag of a regular expression.
 */
function foldCase(text: string): string {
  let folded = '';
  for (let i = 0; i < text.length; i++) {
    const lower = text[i].toLowerCase();
    folded += lower.length === 1 ? lower : text[i];
  }
  return folded;
}

/** A matcher for `glob`: true when the whole text matches it. */
export function compileGlob(glob: string, caseSensitive: boolean): (text: string) => boolean {
  const fold = caseSensitive ? (text: string): string => text : foldCase;
  const tokens = parseGlob(glob, fold);
  return (rawText) => {
    const text = fold(rawText);
    let p = 0;
    let t = 0;
    let starP = -1;
    let starT = 0;
    while (t < text.length) {
      const token = tokens[p];
      if (token?.kind === 'star') {
        starP = p++;
        starT = t;
      } else if (token && matchesOne(token, text[t])) {
        p++;
        t++;
      } else if (starP !== -1) {
        p = starP + 1;
        t = ++starT;
      } else {
        return false;
      }
    }
    while (tokens[p]?.kind === 'star') p++;
    return p === tokens.length;
  };
}

/**
 * A filter for the files a search is limited to: a path (relative to the searched root, with `/`) passes when it matches any of
 * `globs`, or when there are none. A glob without a `/` is matched against the file's name; one with a `/` against the whole path
 * from `root` (preceded by `*` so that it can start at any directory). Matched without regular expressions, like every glob.
 */
export function compileIncludeFilter(root: string, globs: string[]): (relativePath: string) => boolean {
  if (globs.length === 0) return () => true;
  // `root` may use the host's separator (`C:\work`); only the matching text needs one notation.
  const rootPrefix = root.replace(/[\\/]+$/, '');
  const compiled = globs.map((glob) => (glob.includes('/')
    ? { onPath: true, matches: compileGlob(`*/${glob}`, true) }
    : { onPath: false, matches: compileGlob(glob, true) }));
  return (relativePath) => {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return compiled.some((include) => include.matches(include.onPath ? `${rootPrefix}/${relativePath}` : name));
  };
}

const DOUBLE_STAR = Symbol('**');

interface PathGlob {
  /** Matched against the whole path from the root; otherwise against a single name at any depth. */
  anchored: boolean;
  /** Matches directories only (the pattern ended with `/`). */
  directoriesOnly: boolean;
  segments: (((name: string) => boolean) | typeof DOUBLE_STAR)[];
}

/**
 * A glob in the sense of ripgrep's `-g` (gitignore rules): without a `/` (a trailing one aside) it is matched against a name at any
 * depth; with one it is anchored to the root. `*` and `?` stay within one path segment, `**` stands for any number of segments
 * (a trailing `/**` for at least one). Segments are matched with `compileGlob`, so no regular expression is built from user text.
 */
function compilePathGlob(glob: string): PathGlob {
  let text = glob.trim();
  const directoriesOnly = text.endsWith('/');
  if (directoriesOnly) text = text.replace(/\/+$/, '');
  const rooted = text.startsWith('/');
  const parts = text.split('/').filter((part) => part !== '');
  return {
    anchored: rooted || parts.length > 1,
    directoriesOnly,
    segments: parts.map((part) => (part === '**' ? DOUBLE_STAR : compileGlob(part, true))),
  };
}

/** Whether the segments of a glob match all of `parts` (memoized, so a glob full of `**` cannot take exponential time). */
function matchesSegments(glob: PathGlob, parts: string[]): boolean {
  const { segments } = glob;
  const failed = new Set<number>();
  const from = (pi: number, ji: number): boolean => {
    if (pi === segments.length) return ji === parts.length;
    const key = pi * (parts.length + 1) + ji;
    if (failed.has(key)) return false;
    const segment = segments[pi];
    let matched: boolean;
    if (segment === DOUBLE_STAR) {
      matched = false;
      // A trailing `**` stands for at least one segment (`a/**` is what is inside `a`, not `a` itself).
      for (let k = pi === segments.length - 1 ? ji + 1 : ji; k <= parts.length && !matched; k++) matched = from(pi + 1, k);
    } else {
      matched = ji < parts.length && segment(parts[ji]) && from(pi + 1, ji + 1);
    }
    if (!matched) failed.add(key);
    return matched;
  };
  return from(0, 0);
}

export interface SearchPathGlobs {
  /** A file passes when it matches any of these, or when there are none. */
  include: string[];
  /** A file is left out when it, or a directory above it, matches any of these. */
  exclude: string[];
}

/**
 * The files a content search looks at, decided from the path relative to the searched root (always with `/`) as ripgrep decides
 * with `-g 'pattern'` / `-g '!pattern'`: `src/*.ts` is the `.ts` files directly in `src` at the root, not deeper ones, and
 * `src/private/**` leaves out everything below that directory.
 */
export function compileSearchPathFilter(globs: SearchPathGlobs): (relativePath: string) => boolean {
  const includes = globs.include.map(compilePathGlob);
  const excludes = globs.exclude.map(compilePathGlob);
  return (relativePath) => {
    const parts = relativePath.split('/');
    const included = includes.length === 0 || includes.some((glob) => !glob.directoriesOnly
      && matchesSegments(glob, glob.anchored ? parts : [parts[parts.length - 1]]));
    if (!included) return false;
    return !excludes.some((glob) => {
      // The file itself only when the pattern is not for directories; every directory above it always.
      const last = glob.directoriesOnly ? parts.length - 1 : parts.length;
      if (glob.anchored) {
        for (let length = 1; length <= last; length++) if (matchesSegments(glob, parts.slice(0, length))) return true;
        return false;
      }
      for (let i = 0; i < last; i++) if (matchesSegments(glob, [parts[i]])) return true;
      return false;
    });
  };
}

/** The globs among `exclude` that name an entry at any depth (no `/`): the host's walk can leave those out without listing them. */
export function walkExcludeNames(exclude: string[]): string[] {
  return exclude.filter((glob) => !glob.trim().includes('/'));
}
