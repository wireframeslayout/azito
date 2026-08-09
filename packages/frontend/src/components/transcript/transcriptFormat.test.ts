import { describe, expect, it } from 'vitest';
import { dateKeyOf, formatDateSeparator, splitCodeBlocks } from './transcriptFormat';

describe('dateKeyOf', () => {
  it('returns null for a null timestamp', () => {
    expect(dateKeyOf(null)).toBeNull();
  });

  it('returns null for an invalid timestamp', () => {
    expect(dateKeyOf('not-a-date')).toBeNull();
  });

  it('returns the same key for two timestamps on the same local day', () => {
    // Round-trip through local Date construction -> ISO string -> dateKeyOf so the comparison
    // is independent of the test runner's timezone.
    const a = dateKeyOf(new Date(2026, 7, 9, 1, 0, 0).toISOString());
    const b = dateKeyOf(new Date(2026, 7, 9, 23, 0, 0).toISOString());
    expect(a).toBe(b);
  });

  it('returns a different key across a day boundary', () => {
    const a = dateKeyOf(new Date(2026, 7, 9, 23, 59, 59).toISOString());
    const b = dateKeyOf(new Date(2026, 7, 10, 0, 0, 1).toISOString());
    expect(a).not.toBe(b);
  });
});

describe('formatDateSeparator', () => {
  it('returns empty string for an invalid timestamp', () => {
    expect(formatDateSeparator('not-a-date', 'en')).toBe('');
  });

  it('formats a valid timestamp as a non-empty locale string', () => {
    const label = formatDateSeparator('2026-08-09T12:00:00Z', 'en');
    expect(label.length).toBeGreaterThan(0);
  });
});

describe('splitCodeBlocks', () => {
  it('splits a plain fenced block with a word language', () => {
    const text = 'before\n```ts\nconst a = 1;\n```\nafter';
    expect(splitCodeBlocks(text)).toEqual([
      { kind: 'text', text: 'before\n' },
      { kind: 'code', text: 'const a = 1;', lang: 'ts' },
      { kind: 'text', text: '\nafter' },
    ]);
  });

  it('handles language names containing symbols (c++, c#)', () => {
    const text = '```c++\nint x = 1;\n```';
    expect(splitCodeBlocks(text)).toEqual([
      { kind: 'code', text: 'int x = 1;', lang: 'c++' },
    ]);

    const text2 = '```c#\nvar x = 1;\n```';
    expect(splitCodeBlocks(text2)).toEqual([
      { kind: 'code', text: 'var x = 1;', lang: 'c#' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const text = 'before\r\n```ts\r\nconst a = 1;\r\nconst b = 2;\r\n```\r\nafter';
    const result = splitCodeBlocks(text);
    expect(result[1]).toEqual({ kind: 'code', text: 'const a = 1;\r\nconst b = 2;', lang: 'ts' });
  });

  it('trims trailing whitespace from the language name', () => {
    const text = '```ts \nconst a = 1;\n```';
    expect(splitCodeBlocks(text)).toEqual([
      { kind: 'code', text: 'const a = 1;', lang: 'ts' },
    ]);
  });

  it('treats an empty language name as undefined', () => {
    const text = '```\nplain\n```';
    expect(splitCodeBlocks(text)).toEqual([
      { kind: 'code', text: 'plain', lang: undefined },
    ]);
  });

  it('returns the whole text as a single text segment when there is no fence', () => {
    const text = 'just plain text';
    expect(splitCodeBlocks(text)).toEqual([{ kind: 'text', text }]);
  });
});
