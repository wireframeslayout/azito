// Replies the browser's xterm sends on its own: focus in/out (DECSET 1004), device attributes, cursor position,
// DECRPM, status, window size, kitty keyboard flags, DCS (XTVERSION, DECRQSS) and OSC (color) replies.
const REPORT = new RegExp(
  '(?:' + [
    '\\x1b\\[[IO]',
    '\\x1b\\[[?>=]?[\\d;]*c',
    '\\x1b\\[\\??\\d+;\\d+(?:;\\d+)?R',
    '\\x1b\\[\\??[\\d;]+\\$y',
    '\\x1b\\[\\d*n',
    '\\x1b\\[\\d+(?:;\\d+)*t',
    '\\x1b\\[\\?\\d*u',
    '\\x1bP[^\\x1b]*\\x1b\\\\',
    '\\x1b\\][\\d;]+[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
  ].join('|') + ')',
  'y',
);

/**
 * True when `data` is made only of terminal reports, i.e. nothing the user typed. Shift+F3 (`ESC [ 1 ; 2 R`) reads
 * the same as a cursor position report and is counted as one; it is still written, only without claiming the size.
 */
export function isTerminalReport(data: string): boolean {
  if (data.length === 0) return false;
  REPORT.lastIndex = 0;
  while (REPORT.lastIndex < data.length) {
    if (!REPORT.test(data)) return false;
  }
  return true;
}
