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
