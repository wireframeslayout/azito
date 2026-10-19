import { describe, expect, it } from 'vitest';
import { isTerminalReport } from './terminalReports';

describe('isTerminalReport', () => {
  it.each([
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['primary device attributes', '\x1b[?1;2c'],
    ['secondary device attributes', '\x1b[>0;276;0c'],
    ['cursor position', '\x1b[24;80R'],
    ['DECRPM', '\x1b[?2026;2$y'],
    ['status', '\x1b[0n'],
    ['window size', '\x1b[8;44;144t'],
    ['kitty keyboard flags', '\x1b[?0u'],
    ['XTVERSION', '\x1bP>|xterm.js(5.5.0)\x1b\\'],
    ['OSC color, BEL', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'],
    ['OSC color, ST', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
    ['several replies in one chunk', '\x1b[O\x1b[?1;2c'],
  ])('counts %s as a report', (_name, data) => {
    expect(isTerminalReport(data)).toBe(true);
  });

  it.each([
    ['text', 'ls\r'],
    ['empty input', ''],
    ['an arrow key', '\x1b[A'],
    ['a mouse click', '\x1b[<0;10;5M'],
    ['a paste', '\x1b[200~text\x1b[201~'],
    ['a report followed by typing', '\x1b[Ix'],
    ['escape alone', '\x1b'],
  ])('does not count %s', (_name, data) => {
    expect(isTerminalReport(data)).toBe(false);
  });
});
