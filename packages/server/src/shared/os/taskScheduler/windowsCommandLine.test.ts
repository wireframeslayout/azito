import { describe, expect, it } from 'vitest';
import { joinWindowsArgs, quoteWindowsArg } from './windowsCommandLine';

/** CommandLineToArgvW for arguments after the program name (2008+ rules, without the `""` inside quotes extension). */
function splitWindowsArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      let n = 0;
      while (line[i] === '\\') { n++; i++; }
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) { current += '"'; } else { inQuotes = !inQuotes; }
      } else {
        current += '\\'.repeat(n);
        i--;
      }
      started = true;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if ((ch === ' ' || ch === '\t') && !inQuotes) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

const CASES = [
  'plain', '', 'with space', 'tab\there', 'say "hi"', 'C:\\Program Files\\AZITO\\', 'trailing\\', 'trailing space \\',
  'a\\"b', 'a\\\\"b', '日本語 の パス', 'C:\\ユーザー\\私 の\\x.exe', '"', '""', '\\\\server\\share dir\\', 'a=b c', '--flag=va lue',
];

describe('quoteWindowsArg', () => {
  it('leaves a plain argument alone and quotes an empty one', () => {
    expect(quoteWindowsArg('serve')).toBe('serve');
    expect(quoteWindowsArg('')).toBe('""');
  });

  it('quotes spaces, doubles the backslashes before a quote and before the closing quote', () => {
    expect(quoteWindowsArg('C:\\Program Files\\x\\')).toBe('"C:\\Program Files\\x\\\\"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('refuses a NUL byte', () => {
    expect(() => quoteWindowsArg('a\0b')).toThrow(/NUL/);
  });

  it.each(CASES)('is read back as the same single argument: %j', (arg) => {
    expect(splitWindowsArgs(quoteWindowsArg(arg))).toEqual([arg]);
  });
});

describe('joinWindowsArgs', () => {
  it('round-trips the whole list', () => {
    expect(splitWindowsArgs(joinWindowsArgs(CASES))).toEqual(CASES);
  });

  it('is empty for no arguments', () => {
    expect(joinWindowsArgs([])).toBe('');
  });
});
