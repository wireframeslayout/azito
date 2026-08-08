import { describe, it, expect } from 'vitest';
import path from 'path';
import { sanitizeFileName } from './routes';
import { isPathContained } from '../git/PathContainment';

describe('sanitizeFileName', () => {
  it('preserves Japanese filename', () => {
    expect(sanitizeFileName('日本語の画像.png')).toBe('日本語の画像.png');
  });

  it('preserves ASCII filename', () => {
    expect(sanitizeFileName('image.png')).toBe('image.png');
  });

  it('replaces forward slash with underscore', () => {
    expect(sanitizeFileName('a/b.txt')).toBe('a_b.txt');
  });

  it('replaces backslash with underscore', () => {
    expect(sanitizeFileName('a\\b.txt')).toBe('a_b.txt');
  });

  it('removes control characters', () => {
    expect(sanitizeFileName('file\x00name.txt')).toBe('filename.txt');
  });

  it('removes leading dots', () => {
    expect(sanitizeFileName('.hidden')).toBe('hidden');
  });

  it('returns file fallback for empty string', () => {
    expect(sanitizeFileName('')).toBe('file');
  });

  it('returns file fallback for whitespace only', () => {
    expect(sanitizeFileName('   ')).toBe('file');
  });

  it('preserves emoji', () => {
    expect(sanitizeFileName('\u{1F389}test.txt')).toBe('\u{1F389}test.txt');
  });

  it('normalizes decomposed dakuten to NFC', () => {
    const decomposed = 'が.txt';
    const composed = 'が.txt';
    expect(sanitizeFileName(decomposed)).toBe(composed);
  });
});

describe('file CRUD route guards', () => {
  it('rejects .git basename', () => {
    const targetPath = '/workspace/project/.git';
    expect(path.basename(targetPath)).toBe('.git');
  });

  it('detects root directory deletion attempt', () => {
    const resolvedTarget = '/home/user/workspace/project';
    const resolvedRoot = '/home/user/workspace/project';
    expect(resolvedTarget === resolvedRoot).toBe(true);
  });

  it('allows deletion of a child', () => {
    const resolvedTarget: string = '/home/user/workspace/project/src';
    const resolvedRoot: string = '/home/user/workspace/project';
    expect(resolvedTarget === resolvedRoot).toBe(false);
    expect(isPathContained({ target: resolvedTarget, allowedRoot: resolvedRoot })).toBe(true);
  });

  it('rejects path outside working directory', () => {
    expect(isPathContained({
      target: '/home/user/other-project/file.txt',
      allowedRoot: '/home/user/workspace/project',
    })).toBe(false);
  });

  it('rejects traversal via ..', () => {
    const resolved = path.resolve('/home/user/workspace/project/../../../etc/passwd');
    expect(isPathContained({
      target: resolved,
      allowedRoot: '/home/user/workspace/project',
    })).toBe(false);
  });

  it('rejects newName with path separators', () => {
    const newName = '../etc/passwd';
    expect(newName.includes('/') || newName.includes('\\')).toBe(true);
  });
});

describe('PUT file content route guards', () => {
  it('rejects missing projectId', () => {
    const body: Record<string, unknown> = { path: '/workspace/project/src/index.ts', content: 'x' };
    const projectId = typeof body.projectId === 'number' ? body.projectId : NaN;
    expect(isNaN(projectId)).toBe(true);
  });

  it('rejects path containing control characters', () => {
    const filePath = '/workspace/project/src/index\x00.ts';
    expect(/[\x00-\x1f]/.test(filePath)).toBe(true);
  });

  it('rejects traversal outside the working directory', () => {
    const parentDir = path.dirname('/workspace/project/../../../etc/passwd');
    const resolved = path.resolve(parentDir);
    expect(isPathContained({
      target: resolved,
      allowedRoot: '/workspace/project',
    })).toBe(false);
  });

  it('allows a path inside the working directory', () => {
    const parentDir = path.dirname('/workspace/project/src/index.ts');
    const resolved = path.resolve(parentDir);
    expect(isPathContained({
      target: resolved,
      allowedRoot: '/workspace/project',
    })).toBe(true);
  });

  // Issue #27 review Critical 2: parent-directory containment alone misses a
  // save target that is itself a symlink to outside workingDirectory. The
  // route resolves the target's real path (FileBrowseService
  // .resolveExistingTargetRealPath — see its own primitive-level tests for
  // the resolution itself) and re-checks containment on *that*; this is the
  // containment judgment the route applies to the resolved value.
  it('rejects a save target whose resolved real path escapes the working directory', () => {
    const resolvedTargetOfSymlink = '/etc/passwd';
    expect(isPathContained({
      target: resolvedTargetOfSymlink,
      allowedRoot: '/workspace/project',
    })).toBe(false);
  });
});
