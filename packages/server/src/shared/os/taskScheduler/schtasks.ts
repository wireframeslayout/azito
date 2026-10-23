import fs from 'fs';
import * as path from 'path';
import { buildCommandSpec, type CommandResult, type CommandSpec } from '../../exec/commandSpec';
import type { HostEnv } from '../hostEnv';
import { decodeOemOutput, type DecodedOutput, describeUndecodable, parseOemCodePage } from './oemOutput';
import { decodeTaskXml, encodeTaskXml } from './taskDefinition';

/** A finished command with its output as bytes (the OEM code page is decoded here, not by the runner). */
export interface RawCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs one command without a shell and returns its output untouched. Production: `rawRunnerOf(spec => runCommandSpec(spec, { ...runHostOf(host), rawOutput: true }))`. */
export type CommandSpecRunner = (spec: CommandSpec) => Promise<RawCommandResult>;

/** Adapts `runCommandSpec(..., { rawOutput: true })`. A result without the bytes means the runner was not asked for them: an error, not a UTF-8 guess. */
export function rawRunnerOf(run: (spec: CommandSpec) => Promise<CommandResult>): CommandSpecRunner {
  return async (spec) => {
    const result = await run(spec);
    if (result.stdoutBytes === undefined || result.stderrBytes === undefined) {
      throw new Error('The command runner did not return raw output (run it with rawOutput: true)');
    }
    return { exitCode: result.exitCode, stdout: result.stdoutBytes, stderr: result.stderrBytes };
  };
}

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
 * schtasks ran and failed. `detail` is what it printed, decoded from the OEM code page (in the Windows display language);
 * when that cannot be decoded `detail` says so with the bytes in hex, and `rawDetail` always holds the bytes as written.
 */
export class SchtasksError extends Error {
  constructor(readonly operation: SchtasksOperation, readonly taskName: string, readonly exitCode: number, readonly detail: string, readonly rawDetail: Buffer) {
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
 * The first `count` fields of every row of schtasks' CSV (every field quoted, `""` for a quote). Only the leading columns are
 * read, on purpose: they are the ones this client needs (task name, last result) and the ones schtasks quotes properly. Later
 * columns are not RFC 4180: "Task To Run" holds the command line with its quotes as they are (not doubled) and cut at a fixed
 * length, so a task whose command line has quotes (the misao task's) leaves a quote open and a whole-file CSV parser swallows
 * the rest. A line that does not start with a quoted field (the continuation of a multi-line description) is skipped.
 */
export function parseLeadingFields(text: string, count: number): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const fields: string[] = [];
    let i = 0;
    while (fields.length < count && line[i] === '"') {
      let field = '';
      i++;
      for (; i < line.length; i++) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; } else break;
        } else {
          field += line[i];
        }
      }
      if (line[i] !== '"') { fields.length = 0; break; }
      fields.push(field);
      i++;
      if (line[i] === ',') i++;
    }
    if (fields.length > 0) rows.push(fields);
  }
  return rows;
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
  private readonly regPath: string;
  private readonly tmpDir: string | undefined;
  private oemCodePage: Promise<number> | undefined;

    /**
   * `host.tmpDir` is where {@link register} stages the XML on THIS machine. A client whose `run` executes on another host (the
   * hub installing an agent over SSH) has no use for it: it registers with {@link registerFromFile}, a file already on that host.
   */
  constructor(private readonly run: CommandSpecRunner, host: Pick<HostEnv, 'systemRoot'> & Partial<Pick<HostEnv, 'tmpDir'>>) {
    if (host.systemRoot === undefined || host.systemRoot === '') {
      throw new Error('Cannot find schtasks.exe: %SystemRoot% is not set');
    }
    this.schtasksPath = path.win32.join(host.systemRoot, 'System32', 'schtasks.exe');
    this.regPath = path.win32.join(host.systemRoot, 'System32', 'reg.exe');
    this.tmpDir = host.tmpDir;
  }

  /** The OEM code page, read once from the registry (`reg query` prints ASCII only) and remembered. */
  private readOemCodePage(): Promise<number> {
    this.oemCodePage ??= (async () => {
      const spec = buildCommandSpec(this.regPath, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { timeoutMs: SCHTASKS_TIMEOUT_MS, maxOutputBytes: SCHTASKS_OUTPUT_BYTES });
      const result = await this.run(spec);
      if (result.exitCode !== 0) throw new Error(`Cannot read the OEM code page: reg query failed (exit ${result.exitCode})`);
      return parseOemCodePage(result.stdout.toString('ascii'));
    })();
    // A failed read must be tried again next time, not remembered.
    this.oemCodePage.catch(() => { this.oemCodePage = undefined; });
    return this.oemCodePage;
  }

  /** A failed run as an error: stderr (or stdout) decoded from the OEM code page, bytes kept. */
  private async errorOf(operation: SchtasksOperation, taskName: string, result: RawCommandResult): Promise<SchtasksError> {
    const raw = result.stderr.length > 0 ? result.stderr : result.stdout;
    // Not being able to learn the code page must not hide the failure being reported: it becomes the reason for "undecodable".
    const decoded = await decodeOemOutput(raw, () => this.readOemCodePage()).catch((err: unknown): DecodedOutput => ({
      ok: false,
      reason: `the OEM code page could not be read (${err instanceof Error ? err.message : String(err)})`,
    }));
    const detail = decoded.ok ? decoded.text.trim() : describeUndecodable(raw, decoded.reason);
    return new SchtasksError(operation, taskName, result.exitCode, detail, raw);
  }

  private static assertTaskName(name: string): void {
    if (!TASK_NAME.test(name)) throw new Error(`Invalid task name "${name}": letters, digits, ".", "_" and "-" only`);
  }

  private spec(args: string[]): CommandSpec {
    return buildCommandSpec(this.schtasksPath, args, { timeoutMs: SCHTASKS_TIMEOUT_MS, maxOutputBytes: SCHTASKS_OUTPUT_BYTES });
  }

  private async mustSucceed(operation: SchtasksOperation, taskName: string, args: string[]): Promise<void> {
    const result = await this.run(this.spec(args));
    if (result.exitCode !== 0) throw await this.errorOf(operation, taskName, result);
  }

  /** Registers the task, replacing one of the same name (`/F`). The XML goes through a private temporary directory that is removed afterwards. */
  async register(taskName: string, xml: string): Promise<void> {
    SchtasksClient.assertTaskName(taskName);
    if (this.tmpDir === undefined) throw new Error('This SchtasksClient has no temporary directory: register the task from a file on its host with registerFromFile');
    const dir = fs.mkdtempSync(path.join(this.tmpDir, 'azito-schtasks-'));
    try {
      const file = path.join(dir, 'task.xml');
      fs.writeFileSync(file, encodeTaskXml(xml));
      await this.registerFromFile(taskName, file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Registers the task from an XML file that already exists on the host `run` executes on ({@link encodeTaskXml}'s UTF-16 form), replacing one of the same name. */
  async registerFromFile(taskName: string, xmlFile: string): Promise<void> {
    SchtasksClient.assertTaskName(taskName);
    await this.mustSucceed('create', taskName, ['/Create', '/XML', xmlFile, '/TN', taskName, '/F']);
  }

  /**
   * The registered task's definition as XML text (`/Query /XML`, written in the OEM code page and decoded like every schtasks
   * output), for putting the same task back later with {@link encodeTaskXml} + {@link registerFromFile}. Output that cannot
   * be decoded is an error, never a guess: a definition that was misread would be restored wrong.
   */
  async exportXml(taskName: string): Promise<string> {
    SchtasksClient.assertTaskName(taskName);
    const result = await this.run(this.spec(['/Query', '/TN', taskName, '/XML']));
    if (result.exitCode !== 0) throw await this.errorOf('query', taskName, result);
    // A build that writes the UTF-16 file form (BOM) instead of OEM text is read as it declares itself.
    if (result.stdout[0] === 0xff && result.stdout[1] === 0xfe) return decodeTaskXml(result.stdout);
    const decoded = await decodeOemOutput(result.stdout, () => this.readOemCodePage());
    if (!decoded.ok) throw new Error(`Cannot read the definition of the task "${taskName}": ${describeUndecodable(result.stdout, decoded.reason)}`);
    return decoded.text;
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
      if (!(await this.listTaskNames()).some((name) => sameTaskName(name, taskName))) return { exists: false };
      throw await this.errorOf('query', taskName, result);
    }
    const stdout = csvText(result.stdout);
    const row = parseLeadingFields(stdout, LAST_RESULT_COLUMN + 1).find((fields) => sameTaskName(fields[TASK_NAME_COLUMN] ?? '', taskName));
    const lastResult = row ? parseLastResult(row[LAST_RESULT_COLUMN]) : undefined;
    if (lastResult === undefined) throw new Error(`Cannot read the last result of the task "${taskName}" from schtasks output: ${stdout.trim().slice(0, 500)}`);
    return { exists: true, running: lastResult === SCHED_S_TASK_RUNNING, failed: !NOT_A_FAILURE.has(lastResult) && lastResult !== SCHED_S_TASK_RUNNING, lastResult };
  }

  /** `/Query /FO CSV /NH` (without `/V`) has the task name in the first column. */
  private async listTaskNames(): Promise<string[]> {
    const result = await this.run(this.spec(['/Query', '/FO', 'CSV', '/NH']));
    if (result.exitCode !== 0) throw await this.errorOf('query', '*', result);
    return parseLeadingFields(csvText(result.stdout), 1).map((fields) => fields[0] ?? '');
  }
}

/**
 * The CSV only has to be split into records and fields, and the columns read are the task name and a number (both ASCII). In
 * the OEM code pages that matter (CP932 and the other multi-byte ones) no second byte is `"`, `,` or a line break, so reading
 * the bytes one-to-one (latin1) keeps the structure exact whatever the translated columns (Status) contain.
 */
function csvText(bytes: Buffer): string {
  return bytes.toString('latin1');
}

/** Task Scheduler names are case-insensitive (`\\AzitoHub` is found by `azitohub`); the row prints a leading backslash. */
function sameTaskName(listed: string, taskName: string): boolean {
  return listed.toLowerCase() === `\\${taskName}`.toLowerCase();
}

function parseLastResult(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined;
  // schtasks prints a failing HRESULT as a negative decimal; fold it to the unsigned value.
  return Number(value.trim()) >>> 0;
}
