import fs from 'fs';
import * as path from 'path';
import { buildCommandSpec, type CommandResult, type CommandSpec } from '../../exec/commandSpec';
import type { HostEnv } from '../hostEnv';
import { encodeTaskXml } from './taskDefinition';

/** Runs one command without a shell (production: `runCommandSpec(spec, runHostOf(hostEnv))`). */
export type CommandSpecRunner = (spec: CommandSpec) => Promise<CommandResult>;

/** A name that is the same in every code page: schtasks prints and parses names in the OEM code page, which Node does not decode. */
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Task Scheduler's "last run result" codes that are not an exit code of the program (MSDN: Task Scheduler Error and Success Constants). */
export const SCHED_S_TASK_RUNNING = 0x41301;
const SCHED_S_TASK_HAS_NOT_RUN = 0x41303;
const SCHED_S_TASK_TERMINATED = 0x41306;
/** Not a failure: the task has not run yet, or it was stopped on purpose (`/End`). */
const NOT_A_FAILURE = new Set([0, SCHED_S_TASK_HAS_NOT_RUN, SCHED_S_TASK_TERMINATED]);

const SCHTASKS_TIMEOUT_MS = 30_000;
const SCHTASKS_OUTPUT_BYTES = 4 * 1024 * 1024;

export type SchtasksOperation = 'create' | 'run' | 'end' | 'delete' | 'query';

/**
 * schtasks ran and failed (exit code, and what it printed to stderr). `detail` is in the Windows display language and in the
 * OEM code page, which `runCommandSpec` decodes as UTF-8: it can be garbled on a non-English Windows (e.g. CP932), so the
 * exit code is the reliable part. Decoding by the console code page is left to the wiring (#380 B3).
 */
export class SchtasksError extends Error {
  constructor(readonly operation: SchtasksOperation, readonly taskName: string, readonly exitCode: number, readonly detail: string) {
    super(`schtasks /${operation} of the task "${taskName}" failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`);
    this.name = 'SchtasksError';
  }
}

/**
 * The state of a registered task, from what the Task Scheduler reports.
 * `running`: the last result is SCHED_S_TASK_RUNNING. `lastResult` is the exit code of the last run (or a SCHED_* code).
 * The process id is not available from schtasks; a caller that needs it has to ask the process table.
 */
export type TaskScheduleState =
  | { exists: false }
  | { exists: true; running: boolean; failed: boolean; lastResult: number };

/**
 * Parses CSV records (RFC 4180 as schtasks writes them: every field quoted, `""` for a quote, a field may span lines
 * because the task description can).
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  const endField = (): void => {
    record.push(field);
    field = '';
    fieldStarted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
      fieldStarted = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (fieldStarted || field !== '' || record.length > 0) {
        endField();
        records.push(record);
        record = [];
      }
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new Error('schtasks CSV output ended inside a quoted field');
  if (fieldStarted || field !== '' || record.length > 0) {
    endField();
    records.push(record);
  }
  return records;
}

/** `schtasks /Query /FO CSV /NH /V` columns: HostName, TaskName, Next Run Time, Status, Logon Mode, Last Run Time, Last Result. */
const TASK_NAME_COLUMN = 1;
const LAST_RESULT_COLUMN = 6;

/**
 * `schtasks.exe` for one machine. Every call is a {@link CommandSpec} (no shell) on the absolute path under `%SystemRoot%\System32`.
 * - Registration: `/Create /XML <file> /TN <name> /F` from a temporary file that is always removed.
 * - State: `/Query /FO CSV /NH /V`, read by column position and the numeric "Last Result", never by the text of the
 *   Status column, which is translated (a Japanese Windows prints 実行中, not Running). "Does the task exist" is decided
 *   by the task list (also locale independent), not by the text of the "not found" message.
 */
export class SchtasksClient {
  private readonly schtasksPath: string;
  private readonly tmpDir: string;

  constructor(private readonly run: CommandSpecRunner, host: Pick<HostEnv, 'systemRoot' | 'tmpDir'>) {
    if (host.systemRoot === undefined || host.systemRoot === '') {
      throw new Error('Cannot find schtasks.exe: %SystemRoot% is not set');
    }
    this.schtasksPath = path.win32.join(host.systemRoot, 'System32', 'schtasks.exe');
    this.tmpDir = host.tmpDir;
  }

  private static assertTaskName(name: string): void {
    if (!TASK_NAME.test(name)) throw new Error(`Invalid task name "${name}": letters, digits, ".", "_" and "-" only`);
  }

  private spec(args: string[]): CommandSpec {
    return buildCommandSpec(this.schtasksPath, args, { timeoutMs: SCHTASKS_TIMEOUT_MS, maxOutputBytes: SCHTASKS_OUTPUT_BYTES });
  }

  private async mustSucceed(operation: SchtasksOperation, taskName: string, args: string[]): Promise<CommandResult> {
    const result = await this.run(this.spec(args));
    if (result.exitCode !== 0) throw new SchtasksError(operation, taskName, result.exitCode, (result.stderr || result.stdout).trim());
    return result;
  }

  /** Registers the task, replacing one of the same name (`/F`). The XML goes through a private temporary directory that is removed afterwards. */
  async register(taskName: string, xml: string): Promise<void> {
    SchtasksClient.assertTaskName(taskName);
    const dir = fs.mkdtempSync(path.join(this.tmpDir, 'azito-schtasks-'));
    try {
      const file = path.join(dir, 'task.xml');
      fs.writeFileSync(file, encodeTaskXml(xml));
      await this.mustSucceed('create', taskName, ['/Create', '/XML', file, '/TN', taskName, '/F']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async start(taskName: string): Promise<void> {
    SchtasksClient.assertTaskName(taskName);
    await this.mustSucceed('run', taskName, ['/Run', '/TN', taskName]);
  }

  /** Stops the running instance. schtasks fails when nothing is running: check {@link query} first. */
  async stop(taskName: string): Promise<void> {
    SchtasksClient.assertTaskName(taskName);
    await this.mustSucceed('end', taskName, ['/End', '/TN', taskName]);
  }

  async delete(taskName: string): Promise<void> {
    SchtasksClient.assertTaskName(taskName);
    await this.mustSucceed('delete', taskName, ['/Delete', '/TN', taskName, '/F']);
  }

  async query(taskName: string): Promise<TaskScheduleState> {
    SchtasksClient.assertTaskName(taskName);
    const result = await this.run(this.spec(['/Query', '/TN', taskName, '/FO', 'CSV', '/NH', '/V']));
    if (result.exitCode !== 0) {
      // Exit 1 is both "no such task" and "access denied": the task list tells them apart without reading the message.
      if (!(await this.listTaskNames()).includes(`\\${taskName}`)) return { exists: false };
      throw new SchtasksError('query', taskName, result.exitCode, (result.stderr || result.stdout).trim());
    }
    const row = parseCsvRecords(result.stdout).find((fields) => fields[TASK_NAME_COLUMN] === `\\${taskName}`);
    const lastResult = row ? parseLastResult(row[LAST_RESULT_COLUMN]) : undefined;
    if (lastResult === undefined) throw new Error(`Cannot read the last result of the task "${taskName}" from schtasks output: ${result.stdout.trim().slice(0, 500)}`);
    return { exists: true, running: lastResult === SCHED_S_TASK_RUNNING, failed: !NOT_A_FAILURE.has(lastResult) && lastResult !== SCHED_S_TASK_RUNNING, lastResult };
  }

  /** `/Query /FO CSV /NH` (without `/V`) has the task name in the first column. */
  private async listTaskNames(): Promise<string[]> {
    const result = await this.run(this.spec(['/Query', '/FO', 'CSV', '/NH']));
    if (result.exitCode !== 0) throw new SchtasksError('query', '*', result.exitCode, (result.stderr || result.stdout).trim());
    return parseCsvRecords(result.stdout).map((fields) => fields[0] ?? '');
  }
}

function parseLastResult(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined;
  // schtasks prints a failing HRESULT as a negative decimal; fold it to the unsigned value.
  return Number(value.trim()) >>> 0;
}
