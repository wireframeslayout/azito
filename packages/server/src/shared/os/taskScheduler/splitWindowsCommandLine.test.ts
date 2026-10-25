import { describe, expect, it } from 'vitest';
import { joinWindowsArgs, splitWindowsCommandLine } from './windowsCommandLine';

describe('splitWindowsCommandLine', () => {
  it.each([
    [['--headless', 'C:\\Program Files\\nodejs\\node.exe', '--env-file=C:\\Users\\a b\\agent.env', 'C:\\x\\a.cjs']],
    [['a"b', 'c\\', 'd e\\\\', '', 'plain']],
    [['--env-file=C:\\Users\\dev\\.azito\\agent\\agent.env']],
  ])('gives back exactly what joinWindowsArgs joined: %j', (args) => {
    expect(splitWindowsCommandLine(joinWindowsArgs(args))).toEqual(args);
  });

  it('splits on spaces outside quotes only, and keeps an argument that merely contains another whole', () => {
    expect(splitWindowsCommandLine('a  "b c"\td')).toEqual(['a', 'b c', 'd']);
    expect(splitWindowsCommandLine('--note=--env-file=X')).toEqual(['--note=--env-file=X']);
  });

  it('two quotes in a row inside quotes are one literal quote and the quote stays open (the C runtime rule)', () => {
    expect(splitWindowsCommandLine('"a""b" c')).toEqual(['a"b', 'c']);
    expect(splitWindowsCommandLine('"a"""')).toEqual(['a"']);
    expect(splitWindowsCommandLine('"a""')).toEqual(['a"']);
    expect(splitWindowsCommandLine('"a" "" b')).toEqual(['a', '', 'b']);
    expect(splitWindowsCommandLine('x"" y')).toEqual(['x', 'y']);
  });

  it('a settings file followed by extra quotes is not the settings file', () => {
    const wanted = '--env-file=C:\\Users\\dev\\.azito\\agent\\agent.env';
    expect(splitWindowsCommandLine(`"${wanted}"`)).toContain(wanted);
    expect(splitWindowsCommandLine(`"${wanted}"""`)).not.toContain(wanted);
    expect(splitWindowsCommandLine(`"${wanted}""`)).not.toContain(wanted);
    expect(splitWindowsCommandLine(`"${wanted}"""" next`)).not.toContain(wanted);
  });

  it('an empty line has no arguments', () => {
    expect(splitWindowsCommandLine('')).toEqual([]);
    expect(splitWindowsCommandLine('   ')).toEqual([]);
  });
});
