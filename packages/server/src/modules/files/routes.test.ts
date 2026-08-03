import { describe, it, expect } from 'vitest';
import { sanitizeFileName } from './routes';

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
    expect(sanitizeFileName('🎉test.txt')).toBe('🎉test.txt');
  });

  it('normalizes decomposed dakuten to NFC', () => {
    // が decomposed: か (U+304B) + combining dakuten (U+3099)
    const decomposed = 'が.txt';
    const composed = 'が.txt';
    expect(sanitizeFileName(decomposed)).toBe(composed);
  });
});
