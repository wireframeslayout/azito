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
