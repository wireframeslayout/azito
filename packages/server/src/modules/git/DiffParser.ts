export interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  file: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isBinary: boolean;
  group?: 'staged' | 'unstaged' | 'untracked';
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
// git quotes paths containing spaces/non-ASCII: `diff --git "a/…" "b/…"`
const QUOTED_HEADER_RE = /^"a\/(?:[^"\\]|\\.)*" ("b\/(?:[^"\\]|\\.)*")$/;

// Escape map from git quote.c (C-style quoting).
const QUOTE_ESCAPES: Record<string, number | undefined> = {
  a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, '"': 0x22, '\\': 0x5c,
};

/**
 * Decodes a git-quoted path: strips surrounding double quotes and resolves
 * C-style escapes (`\a \b \f \n \r \t \v \" \\`) and octal `\NNN` escapes
 * (octal sequences are UTF-8 bytes). Returns the input unchanged when it is
 * not quoted.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  // Iterate by code point so surrogate pairs (e.g. emoji) survive the
  // byte-level round trip. Escape sequences are all ASCII.
  const chars = Array.from(raw.slice(1, -1));
  const bytes: number[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf-8')) bytes.push(b);
      i++;
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      i++;
    } else if (/^[0-7]$/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /^[0-7]$/.test(chars[i + 1 + octal.length] ?? '')) {
        octal += chars[i + 1 + octal.length];
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      i += 1 + octal.length;
    } else {
      const mapped = QUOTE_ESCAPES[next];
      if (mapped !== undefined) {
        bytes.push(mapped);
      } else {
        for (const b of Buffer.from(next, 'utf-8')) bytes.push(b);
      }
      i += 2;
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** Extracts the `b/` path from a `diff --git` header line (quoted or plain form). */
function parseHeaderBPath(headerLine: string): string | null {
  const quoted = QUOTED_HEADER_RE.exec(headerLine.trim());
  if (quoted) return unquoteGitPath(quoted[1]).slice('b/'.length);
  const bPathMatch = headerLine.match(/ b\/(.+)$/);
  return bPathMatch ? bPathMatch[1] : null;
}

/** Extracts the path from a `--- a/…` / `+++ b/…` line (quoted or plain form). */
function parseFileLine(line: string, prefix: 'a/' | 'b/'): string | null {
  const path = unquoteGitPath(line.slice(4));
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function parseHunks(lines: string[]): { hunks: DiffHunk[]; isBinary: boolean } {
  const hunks: DiffHunk[] = [];
  let isBinary = false;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('Binary files')) {
      isBinary = true;
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] != null ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] != null ? parseInt(hunkMatch[4], 10) : 1,
        header: line,
        lines: [],
      };
      hunks.push(currentHunk);
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', content: line.slice(1), oldLine: null, newLine: newLine++ });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine++, newLine: null });
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : '', oldLine: oldLine++, newLine: newLine++ });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    }
  }

  return { hunks, isBinary };
}

export function parseUnifiedDiff(diffOutput: string): FileDiff[] {
  if (!diffOutput.trim()) return [];

  const files: FileDiff[] = [];
  const fileSections = diffOutput.split(/^diff --git /m);

  for (const section of fileSections) {
    if (!section.trim()) continue;

    const lines = section.split('\n');
    const headerLine = lines[0];

    let status: 'A' | 'M' | 'D' | 'R' = 'M';
    let isRename = false;
    let contentStartIndex = 1;
    let renameTo: string | null = null;
    let oldPath: string | null = null;
    let newPath: string | null = null;

    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('--- ')) {
        if (l === '--- /dev/null') status = 'A';
        else oldPath = parseFileLine(l, 'a/');
        contentStartIndex = i;
        continue;
      }
      if (l.startsWith('+++ ')) {
        if (l === '+++ /dev/null') status = 'D';
        else newPath = parseFileLine(l, 'b/');
        contentStartIndex = i;
        break;
      }
      if (l.startsWith('rename from')) {
        isRename = true;
      }
      if (l.startsWith('rename to')) {
        renameTo = unquoteGitPath(l.slice('rename to '.length));
        status = 'R';
      }
      if (l.startsWith('new file')) {
        status = 'A';
      }
      if (l.startsWith('deleted file')) {
        status = 'D';
      }
      if (l.startsWith('Binary files') || l.startsWith('@@')) {
        contentStartIndex = i;
        break;
      }
    }

    if (isRename && status !== 'R') status = 'R';

    // Prefer `+++`/`---` lines: unlike the `diff --git a/… b/…` header, the
    // whole line is the path, so unquoted paths with spaces are unambiguous.
    // The header is only a fallback (e.g. binary or mode-only changes).
    const file = renameTo
      ?? (status === 'D' ? oldPath : newPath)
      ?? parseHeaderBPath(headerLine);
    if (file === null) continue;

    const contentLines = lines.slice(contentStartIndex).filter(
      (l) => !l.startsWith('--- ') && !l.startsWith('+++ ') && !l.startsWith('index '),
    );
    if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
      contentLines.pop();
    }

    const { hunks, isBinary } = parseHunks(contentLines);

    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add') additions++;
        if (line.type === 'del') deletions++;
      }
    }

    files.push({ file, status, additions, deletions, hunks, isBinary });
  }

  return files;
}
