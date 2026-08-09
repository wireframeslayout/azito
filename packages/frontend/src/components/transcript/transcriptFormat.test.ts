import { describe, expect, it } from 'vitest';
import { splitCodeBlocks } from './transcriptFormat';

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
