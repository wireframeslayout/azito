import { describe, it, expect } from 'vitest';
import { parseRipgrepJson } from './parseRipgrepJson';

describe('parseRipgrepJson', () => {
  it('parses a match line', () => {
    const input = JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/home/user/project/src/main.ts' },
        line_number: 42,
        lines: { text: 'const foo = "hello world";\n' },
        submatches: [{ start: 14, end: 19 }],
      },
    });

    const result = parseRipgrepJson(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      path: '/home/user/project/src/main.ts',
      line: 42,
      column: 15,
      text: 'const foo = "hello world";',
      matchStart: 14,
      matchEnd: 19,
    });
  });

  it('skips begin and end lines', () => {
    const lines = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'file.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'file.ts' },
          line_number: 1,
          lines: { text: 'hello\n' },
          submatches: [{ start: 0, end: 5 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'file.ts' } } }),
    ].join('\n');

    const result = parseRipgrepJson(lines);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('file.ts');
  });

  it('skips summary lines', () => {
    const lines = [
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'a.ts' },
          line_number: 10,
          lines: { text: 'test\n' },
          submatches: [{ start: 0, end: 4 }],
        },
      }),
      JSON.stringify({ type: 'summary', data: { elapsed_total: { secs: 0 } } }),
    ].join('\n');

    const result = parseRipgrepJson(lines);
    expect(result).toHaveLength(1);
  });

  it('skips invalid JSON lines gracefully', () => {
    const lines = [
      'this is not json',
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'valid.ts' },
          line_number: 5,
          lines: { text: 'found\n' },
          submatches: [{ start: 0, end: 5 }],
        },
      }),
      '{ broken json',
    ].join('\n');

    const result = parseRipgrepJson(lines);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('valid.ts');
  });

  it('returns empty array for empty input', () => {
    expect(parseRipgrepJson('')).toEqual([]);
    expect(parseRipgrepJson('  \n  ')).toEqual([]);
  });

  it('handles multiple matches across files', () => {
    const lines = [
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'a.ts' },
          line_number: 1,
          lines: { text: 'import foo\n' },
          submatches: [{ start: 7, end: 10 }],
        },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'b.ts' },
          line_number: 20,
          lines: { text: 'export const foo = 1;\n' },
          submatches: [{ start: 13, end: 16 }],
        },
      }),
    ].join('\n');

    const result = parseRipgrepJson(lines);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('a.ts');
    expect(result[1].path).toBe('b.ts');
    expect(result[1].line).toBe(20);
    expect(result[1].matchStart).toBe(13);
    expect(result[1].matchEnd).toBe(16);
  });

  it('handles match with no submatches', () => {
    const input = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'file.ts' },
        line_number: 3,
        lines: { text: 'no submatch\n' },
        submatches: [],
      },
    });

    const result = parseRipgrepJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].matchStart).toBe(0);
    expect(result[0].matchEnd).toBe(0);
  });
});
