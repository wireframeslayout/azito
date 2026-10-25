import { describe, expect, it } from 'vitest';
import { buildProcessListSpec, listProcessesWith, parsePosixPsOutput, parseProcessList, parseWindowsProcessOutput } from './processList';
import type { CommandResult } from '../exec/commandSpec';

const NOW = 1_700_000_000_000;

function result(over: Partial<CommandResult>): CommandResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', ...over };
}

describe('parsePosixPsOutput', () => {
  it('reads pid / ppid / elapsed time / rss / command line from `ps -e -o pid=,ppid=,etime=,rss=,args=`', () => {
    const output = [
      '59026 58986       00:42 20480 claude --dangerously-skip-permissions --model claude-opus-4-6[1m]',
      '    1     0 5-03:04:05   512 /sbin/init splash',
    ].join('\n');
    expect(parsePosixPsOutput(output, NOW)).toEqual([
      { pid: 59026, ppid: 58986, startMs: NOW - 42_000, executable: null, commandLine: 'claude --dangerously-skip-permissions --model claude-opus-4-6[1m]', rssBytes: 20480 * 1024 },
      { pid: 1, ppid: 0, startMs: NOW - ((5 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000, executable: null, commandLine: '/sbin/init splash', rssBytes: 512 * 1024 },
    ]);
  });

  it('reads the hh:mm:ss form (no days) that both Linux and macOS print', () => {
    expect(parsePosixPsOutput('7 1 01:02:03 100 sleep 9', NOW)[0].startMs).toBe(NOW - (3600 + 120 + 3) * 1000);
  });

  it('keeps spaces and digits that belong to the command line', () => {
    const [entry] = parsePosixPsOutput('7 1 00:05 100 node -e 12 34 56:78', NOW);
    expect(entry.commandLine).toBe('node -e 12 34 56:78');
  });

  it('skips blank lines and lines that are not a process', () => {
    expect(parsePosixPsOutput('\n  \nPID PPID ELAPSED\n123 1 00:10', NOW)).toEqual([]);
  });
});

describe('parseWindowsProcessOutput', () => {
  it('turns a FILETIME into epoch ms, independent of the locale', () => {
    // 2023-11-14T22:13:20Z is 1_700_000_000_000 ms; FILETIME counts 100ns from 1601-01-01.
    const fileTime = String((1_700_000_000_000 + 11_644_473_600_000) * 10_000);
    const [entry] = parseWindowsProcessOutput(JSON.stringify([
      { pid: 4321, ppid: 100, fileTime, executable: 'C:\\Program Files\\nodejs\\node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe" x.js', rss: '1048576' },
    ]));
    expect(entry).toEqual({ pid: 4321, ppid: 100, startMs: 1_700_000_000_000, executable: 'C:\\Program Files\\nodejs\\node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe" x.js', rssBytes: 1_048_576 });
  });

  it('keeps a process the host tells nothing about (System Idle: no start, path or command line)', () => {
    const [entry] = parseWindowsProcessOutput('[{"pid":0,"ppid":0,"fileTime":null,"executable":null,"commandLine":null,"rss":"8192"}]');
    expect(entry).toEqual({ pid: 0, ppid: 0, startMs: null, executable: null, commandLine: '', rssBytes: 8192 });
  });

  it('reads an empty list, and rejects output that is not the expected JSON', () => {
    expect(parseWindowsProcessOutput('[]\r\n')).toEqual([]);
    expect(() => parseWindowsProcessOutput('not json')).toThrow();
    expect(() => parseWindowsProcessOutput('[{"pid":"x"}]')).toThrow();
  });
});

describe('buildProcessListSpec', () => {
  it('runs ps without a shell on Unix', () => {
    expect(buildProcessListSpec('linux')).toMatchObject({ file: 'ps', args: ['-e', '-o', 'pid=,ppid=,etime=,rss=,args='] });
    expect(buildProcessListSpec('darwin')).toMatchObject({ file: 'ps' });
  });

  it('runs a PowerShell EncodedCommand on Windows that asks CIM for FILETIMEs', () => {
    const spec = buildProcessListSpec('win32');
    expect(spec.file).toBe('powershell.exe');
    const encoded = spec.args[spec.args.indexOf('-EncodedCommand') + 1];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain('Get-CimInstance -ClassName Win32_Process');
    expect(script).toContain('ToFileTimeUtc()');
    expect(script).not.toMatch(/wmic/i);
  });
});

describe('listProcessesWith', () => {
  it('parses the output by the platform and asks the runner for that platform\'s command', async () => {
    const asked: string[] = [];
    const list = await listProcessesWith('linux', async (spec) => {
      asked.push(spec.file);
      return result({ stdout: '5 1 00:03 64 bash' });
    });
    expect(asked).toEqual(['ps']);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pid: 5, ppid: 1, commandLine: 'bash', rssBytes: 65536 });
  });

  it('rejects with the reason when the command fails (never an empty list)', async () => {
    await expect(listProcessesWith('linux', async () => result({ exitCode: 1, stderr: 'ps: boom' }))).rejects.toThrow('Listing processes failed (exit 1): ps: boom');
  });
});

describe('parseProcessList', () => {
  it('accepts the list an agent sends and rejects another shape', () => {
    const entry = { pid: 1, ppid: 0, startMs: null, executable: null, commandLine: 'x', rssBytes: null };
    expect(parseProcessList([entry])).toEqual([entry]);
    expect(() => parseProcessList([{ pid: 1 }])).toThrow();
    expect(() => parseProcessList({})).toThrow();
  });
});
