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

  it('an empty line has no arguments', () => {
    expect(splitWindowsCommandLine('')).toEqual([]);
    expect(splitWindowsCommandLine('   ')).toEqual([]);
  });
});
