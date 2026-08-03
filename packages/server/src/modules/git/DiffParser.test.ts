import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, unquoteGitPath } from './DiffParser';

describe('parseUnifiedDiff', () => {
  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('  \n  ')).toEqual([]);
  });

  it('parses a simple modified file', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe('src/foo.ts');
    expect(files[0].status).toBe('M');
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[0].isBinary).toBe(false);
    expect(files[0].hunks).toHaveLength(1);

    const hunk = files[0].hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(hunk.lines).toHaveLength(5);
    expect(hunk.lines[0]).toEqual({ type: 'context', content: 'const a = 1;', oldLine: 1, newLine: 1 });
    expect(hunk.lines[1]).toEqual({ type: 'del', content: 'const b = 2;', oldLine: 2, newLine: null });
    expect(hunk.lines[2]).toEqual({ type: 'add', content: 'const b = 3;', oldLine: null, newLine: 2 });
    expect(hunk.lines[3]).toEqual({ type: 'add', content: 'const c = 4;', oldLine: null, newLine: 3 });
    expect(hunk.lines[4]).toEqual({ type: 'context', content: 'const d = 5;', oldLine: 3, newLine: 4 });
  });

  it('detects new file (status A)', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line 1
+line 2
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('A');
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(0);
  });

  it('detects deleted file (status D)', () => {
    const diff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line 1
-line 2
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('D');
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(2);
  });

  it('detects renamed file (status R)', () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('R');
    expect(files[0].file).toBe('new-name.ts');
  });

  it('detects binary files', () => {
    const diff = `diff --git a/image.png b/image.png
index abc1234..def5678 100644
Binary files a/image.png and b/image.png differ
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].isBinary).toBe(true);
    expect(files[0].hunks).toHaveLength(0);
  });

  it('parses multiple files in a single diff', () => {
    const diff = `diff --git a/a.ts b/a.ts
index abc..def 100644
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
 line1
+line2
diff --git a/b.ts b/b.ts
new file mode 100644
index 000..abc
--- /dev/null
+++ b/b.ts
@@ -0,0 +1 @@
+new file content
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].file).toBe('a.ts');
    expect(files[0].status).toBe('M');
    expect(files[1].file).toBe('b.ts');
    expect(files[1].status).toBe('A');
  });

  it('handles multiple hunks in one file', () => {
    const diff = `diff --git a/multi.ts b/multi.ts
index abc..def 100644
--- a/multi.ts
+++ b/multi.ts
@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -10,3 +10,3 @@
 line10
-old11
+new11
 line12
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[0].oldStart).toBe(1);
    expect(files[0].hunks[1].oldStart).toBe(10);
  });

  it('handles "no newline at end of file" marker', () => {
    const diff = `diff --git a/no-eol.ts b/no-eol.ts
index abc..def 100644
--- a/no-eol.ts
+++ b/no-eol.ts
@@ -1,2 +1,2 @@
 line1
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const hunk = files[0].hunks[0];
    expect(hunk.lines.every(l => l.type !== 'context' || l.content !== ' No newline at end of file')).toBe(true);
  });

  it('does not produce phantom trailing context line', () => {
    const diff = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
 context
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    const hunk = files[0].hunks[0];
    expect(hunk.lines).toHaveLength(3);
    expect(hunk.lines[2].type).toBe('add');
  });

  it('parses quoted header with octal-escaped Japanese filename', () => {
    const diff = `diff --git "a/\\346\\226\\260\\350\\246\\217.txt" "b/\\346\\226\\260\\350\\246\\217.txt"
index abc..def 100644
--- "a/\\346\\226\\260\\350\\246\\217.txt"
+++ "b/\\346\\226\\260\\350\\246\\217.txt"
@@ -1,1 +1,2 @@
 line1
+line2
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe('新規.txt');
    expect(files[0].status).toBe('M');
    expect(files[0].additions).toBe(1);
  });

  it('parses quoted header with raw UTF-8 Japanese filename (core.quotepath=false)', () => {
    const diff = `diff --git "a/新 ファイル.txt" "b/新 ファイル.txt"
index abc..def 100644
--- "a/新 ファイル.txt"
+++ "b/新 ファイル.txt"
@@ -1,1 +1,1 @@
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe('新 ファイル.txt');
  });

  it('parses unquoted path containing spaces (git does not quote space-only paths)', () => {
    const diff = `diff --git a/my file.txt b/my file.txt
index abc..def 100644
--- a/my file.txt
+++ b/my file.txt
@@ -1,1 +1,1 @@
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe('my file.txt');
    expect(files[0].status).toBe('M');
  });

  it('parses ambiguous unquoted path containing " b/" via the +++ line', () => {
    const diff = `diff --git a/dir b/file.txt b/dir b/file.txt
index abc..def 100644
--- a/dir b/file.txt
+++ b/dir b/file.txt
@@ -1,1 +1,1 @@
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe('dir b/file.txt');
  });

  it('parses deleted file with spaces via the --- line', () => {
    const diff = `diff --git a/gone file.txt b/gone file.txt
deleted file mode 100644
index abc..0000000
--- a/gone file.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('D');
    expect(files[0].file).toBe('gone file.txt');
  });

  it('parses unquoted rename with spaces', () => {
    const diff = `diff --git a/old file.ts b/new file.ts
similarity index 90%
rename from old file.ts
rename to new file.ts
index abc..def 100644
--- a/old file.ts
+++ b/new file.ts
@@ -1,1 +1,1 @@
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('R');
    expect(files[0].file).toBe('new file.ts');
  });

  it('parses quoted rename lines (octal-escaped Japanese filenames)', () => {
    const diff = `diff --git "a/\\346\\227\\247.txt" "b/\\346\\226\\260.txt"
similarity index 90%
rename from "\\346\\227\\247.txt"
rename to "\\346\\226\\260.txt"
index abc..def 100644
--- "a/\\346\\227\\247.txt"
+++ "b/\\346\\226\\260.txt"
@@ -1,1 +1,1 @@
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('R');
    expect(files[0].file).toBe('新.txt');
  });

  it('parses a diff mixing quoted and unquoted headers', () => {
    const diff = `diff --git "a/\\343\\201\\202.txt" "b/\\343\\201\\202.txt"
index abc..def 100644
--- "a/\\343\\201\\202.txt"
+++ "b/\\343\\201\\202.txt"
@@ -1,1 +1,2 @@
 line1
+line2
diff --git a/plain.ts b/plain.ts
new file mode 100644
index 000..abc
--- /dev/null
+++ b/plain.ts
@@ -0,0 +1 @@
+content
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].file).toBe('あ.txt');
    expect(files[1].file).toBe('plain.ts');
    expect(files[1].status).toBe('A');
  });
});

describe('unquoteGitPath', () => {
  it('returns unquoted input unchanged', () => {
    expect(unquoteGitPath('src/foo.ts')).toBe('src/foo.ts');
  });

  it('strips quotes from a plain quoted path', () => {
    expect(unquoteGitPath('"my file.txt"')).toBe('my file.txt');
  });

  it('decodes octal escapes as UTF-8 bytes', () => {
    expect(unquoteGitPath('"\\343\\201\\202.txt"')).toBe('あ.txt');
  });

  it('decodes character escapes', () => {
    expect(unquoteGitPath('"a\\"b\\\\c\\td\\ne"')).toBe('a"b\\c\td\ne');
  });

  it('decodes the full C-style escape set (\\a \\b \\f \\r \\v)', () => {
    expect(unquoteGitPath('"x\\ay\\bz\\f1\\r2\\v3"')).toBe('x\x07y\x08z\x0c1\r2\x0b3');
  });

  it('preserves surrogate pairs (emoji) in unescaped segments', () => {
    expect(unquoteGitPath('"\u{1F600} file\\t.txt"')).toBe('\u{1F600} file\t.txt');
  });
});
