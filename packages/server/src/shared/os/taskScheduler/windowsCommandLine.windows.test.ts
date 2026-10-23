import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildTaskXml, encodeTaskXml } from './taskDefinition';
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

  it('keeps the arguments through a real XML parser (PowerShell [xml]), CR and LF included', () => {
    const args = ['a\rb', 'c\r\nd', 'e\nf', '<&>', ...CASES];
    const xml = buildTaskXml({
      userId: 'PC\\me', description: 'd', executable: 'C:\\x\\y.exe', args, workingDirectory: 'C:\\x', restartOnFailure: { intervalMinutes: 1, count: 1 },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-xml-'));
    try {
      const file = path.join(dir, 'task.xml');
      fs.writeFileSync(file, encodeTaskXml(xml));
      const script = '$x = New-Object System.Xml.XmlDocument; $x.Load($env:AZITO_XML); ' +
        '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($x.Task.Actions.Exec.Arguments)))';
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', env: { ...process.env, AZITO_XML: file } });
      expect(result.status, result.stderr).toBe(0);
      expect(Buffer.from(result.stdout, 'base64').toString('utf-8')).toBe(joinWindowsArgs(args));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
