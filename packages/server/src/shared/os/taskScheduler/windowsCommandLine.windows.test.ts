import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { joinWindowsArgs, quoteWindowsArg } from './windowsCommandLine';

/**
 * The quoting is checked against a real Windows process (Node's own CommandLineToArgvW-compatible parser), not only against
 * the reference splitter in windowsCommandLine.test.ts, which the same author wrote.
 */
const CASES = [
  'plain', '', 'with space', 'tab\there', 'say "hi"', 'C:\\Program Files\\AZITO\\', 'trailing\\', 'trailing space \\',
  'a\\"b', 'a\\\\"b', '日本語 の パス', 'C:\\ユーザー\\私 の\\x.exe', '"', '""', '\\\\server\\share dir\\', '--flag=va lue',
];

describe.skipIf(process.platform !== 'win32')('joinWindowsArgs against a real process', () => {
  it('delivers every argument to the child exactly as it was', () => {
    // The script prints its argv as base64 of UTF-8 JSON, so the console code page cannot alter it.
    const script = 'process.stdout.write(Buffer.from(JSON.stringify(process.argv.slice(1))).toString("base64"))';
    const commandLine = [quoteWindowsArg('-e'), quoteWindowsArg(script), joinWindowsArgs(CASES)].join(' ');
    const result = spawnSync(process.execPath, [commandLine], { encoding: 'utf-8', windowsVerbatimArguments: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(Buffer.from(result.stdout, 'base64').toString('utf-8'))).toEqual(CASES);
  });
});
