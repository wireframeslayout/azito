import { spawnSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { joinWindowsArgs } from '../../shared/os/taskScheduler/windowsCommandLine';
import { ARGV_HELPER } from './windowsHubService';

/**
 * The command line of a process is split by Windows' own `CommandLineToArgvW` (what `findHubProcesses` does to tell the update process from
 * every other `node.exe azito-hub.cjs ...`). Here it is run on the real thing, for the command lines `joinWindowsArgs` builds: what goes in
 * comes back out, whatever the quoting, so a path that contains `update-run` is one argument and never the word after `azito-hub.cjs`.
 */
function split(commandLine: string): string[] {
  const powershell = path.join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(commandLine, 'utf-8').toString('base64');
  const script = [
    ARGV_HELPER,
    `[AzitoArgv]::Split([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))) | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }`,
  ].join('\n');
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf-8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`powershell failed: ${r.stdout}${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter((l) => l !== '').map((l) => Buffer.from(l, 'base64').toString('utf-8'));
}

describe.skipIf(process.platform !== 'win32')('splitting a command line with CommandLineToArgvW', () => {
  const cases: string[][] = [
    ['C:\\node.exe', 'C:\\Users\\Foo Bar (Work)\\.azito\\hub\\v1.0.0\\azito-hub.cjs', 'update-run', '--version', 'v1.1.0'],
    ['C:\\node.exe', 'C:\\x\\update-run\\hub\\v1.0.0\\azito-hub.cjs', 'misao', 'install'],
    ['C:\\node.exe', 'C:\\x\\hub\\v1.0.0\\azito-hub.cjs', 'service', 'restart', '--note=update-run'],
    ['C:\\node.exe', 'C:\\x\\hub\\v1.0.0\\azito-hub.cjs', 'say "update-run"', 'back\\slash\\', 'ユーザー'],
  ];
  it.each(cases)('gives back what joinWindowsArgs put in (%s …)', (...args) => {
    expect(split(joinWindowsArgs(args))).toEqual(args);
  });
});
