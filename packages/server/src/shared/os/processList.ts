import { z } from 'zod';
import { buildCommandSpec, type CommandResult, type CommandSpec } from '../exec/commandSpec';
import { powershellEncodedArgs } from './shellDialect';

/** Agent endpoint (behind the agent token) where an agent lists the processes of its host. */
export const AGENT_PROCESSES_PATH = '/api/processes';

const PROCESS_LIST_TIMEOUT_MS = 15_000;
const PROCESS_LIST_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The Windows FILETIME epoch (1601-01-01) in ms before the Unix epoch. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

const processEntrySchema = z.object({
  pid: z.number().int().nonnegative(),
  ppid: z.number().int().nonnegative(),
  /** When the process started, epoch ms. Null: the host does not say (Windows System / Idle). */
  startMs: z.number().nonnegative().nullable(),
  /** The program's path as the host reports it. Null: not reported apart from the command line (Unix `ps`; a protected Windows process). */
  executable: z.string().nullable(),
  commandLine: z.string(),
  /** Resident memory in bytes. Null when the host did not report it. */
  rssBytes: z.number().nonnegative().nullable(),
});

/** One process of a host, the same shape for every OS. */
export type ProcessEntry = z.infer<typeof processEntrySchema>;

const processListSchema = z.array(processEntrySchema);

/** Reads a process list that crossed the agent wire (`GET /api/processes`). A body of another shape is an error. */
export function parseProcessList(body: unknown): ProcessEntry[] {
  return processListSchema.parse(body);
}

/**
 * True when `entry` cannot be a child of the process its `ppid` names, because it started before it. Once a parent has ended
 * its pid can be reused by an unrelated process, and the child's ppid (on Windows, ParentProcessId) then points at that one.
 * Decided only when both start times are known; otherwise the edge is kept. `startByPid` maps every listed pid to its start.
 */
export function startedBeforeParent(entry: ProcessEntry, startByPid: ReadonlyMap<number, number | null>): boolean {
  const parentStart = startByPid.get(entry.ppid);
  return entry.startMs !== null && parentStart !== undefined && parentStart !== null && entry.startMs < parentStart;
}

/** What a caller of `listProcesses` may ask for. */
export interface ListProcessesOptions {
  /** How long the listing may take before it is abandoned. Default: {@link PROCESS_LIST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Runs a spec on the host that owns the processes (a transport's `run`, or the shared runner). */
export type RunSpec = (spec: CommandSpec) => Promise<CommandResult>;

/**
 * `etime` (`[[dd-]hh:]mm:ss`) is understood by both Linux and macOS `ps`; `etimes` (plain seconds) is not available on macOS.
 * Every column before `args` is a number or a clock, so a command line with spaces cannot shift them.
 */
const POSIX_PS_ARGS = ['-e', '-o', 'pid=,ppid=,etime=,rss=,args='];
const POSIX_PS_LINE = /^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(\d+)\s+(.*)$/;

/**
 * Parses the output of `ps` with {@link POSIX_PS_ARGS}. A line that is not a process (a blank one, an unexpected format) is
 * skipped. The start time is `nowMs` minus the elapsed time, so `nowMs` is the moment the list was taken.
 */
export function parsePosixPsOutput(output: string, nowMs: number): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = POSIX_PS_LINE.exec(line);
    if (!m) continue;
    const days = m[3] ? Number(m[3]) : 0;
    const hours = m[4] ? Number(m[4]) : 0;
    const elapsedSec = ((days * 24 + hours) * 60 + Number(m[5])) * 60 + Number(m[6]);
    entries.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startMs: nowMs - elapsedSec * 1000,
      executable: null,
      commandLine: m[8],
      rssBytes: Number(m[7]) * 1024,
    });
  }
  return entries;
}

/**
 * The Windows script: Win32_Process through CIM (`wmic` is gone from current Windows). Only integers and strings are printed:
 * the creation time as a FILETIME (`ToFileTimeUtc()`), not as a localized date text. The output is UTF-8 JSON, one array
 * (`-InputObject` keeps a single process an array).
 */
const WINDOWS_PROCESS_SCRIPT = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$list = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {
  $created = $null
  if ($_.CreationDate) { $created = [string]$_.CreationDate.ToUniversalTime().ToFileTimeUtc() }
  [ordered]@{
    pid = [int64]$_.ProcessId
    ppid = [int64]$_.ParentProcessId
    fileTime = $created
    executable = $_.ExecutablePath
    commandLine = $_.CommandLine
    rss = [string]$_.WorkingSetSize
  }
})
Write-Output (ConvertTo-Json -InputObject $list -Compress -Depth 3)
`;

const windowsRowSchema = z.object({
  pid: z.number().int().nonnegative(),
  ppid: z.number().int().nonnegative(),
  fileTime: z.string().regex(/^\d+$/).nullable(),
  executable: z.string().nullable(),
  commandLine: z.string().nullable(),
  rss: z.string().regex(/^\d+$/).nullable(),
});

/** Parses the output of the Windows script. A process whose command line is hidden from us (a protected one) has an empty one. */
export function parseWindowsProcessOutput(output: string): ProcessEntry[] {
  const text = output.trim();
  const rows = z.array(windowsRowSchema).parse(JSON.parse(text === '' ? '[]' : text));
  return rows.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    startMs: row.fileTime === null ? null : Math.round(Number(row.fileTime) / 10_000 - FILETIME_EPOCH_OFFSET_MS),
    executable: row.executable,
    commandLine: row.commandLine ?? '',
    rssBytes: row.rss === null ? null : Number(row.rss),
  }));
}

/** The command that lists the processes of a host of `platform`. */
export function buildProcessListSpec(platform: NodeJS.Platform, timeoutMs: number = PROCESS_LIST_TIMEOUT_MS): CommandSpec {
  const options = { timeoutMs, maxOutputBytes: PROCESS_LIST_MAX_OUTPUT_BYTES };
  if (platform === 'win32') return buildCommandSpec('powershell.exe', powershellEncodedArgs(WINDOWS_PROCESS_SCRIPT), options);
  return buildCommandSpec('ps', POSIX_PS_ARGS, options);
}

/**
 * Lists the processes of a host of `platform` by running {@link buildProcessListSpec} through `run`: the one place that
 * knows how, for the hub's own host and for an agent's. A failing command is an error, never an empty list.
 */
export async function listProcessesWith(platform: NodeJS.Platform, run: RunSpec, options: ListProcessesOptions = {}): Promise<ProcessEntry[]> {
  const result = await run(buildProcessListSpec(platform, options.timeoutMs));
  const takenAt = Date.now();
  if (result.exitCode !== 0) {
    throw new Error(`Listing processes failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  }
  return platform === 'win32' ? parseWindowsProcessOutput(result.stdout) : parsePosixPsOutput(result.stdout, takenAt);
}
