import { HostProfileError } from '../../shared/os/hostProfile';
import type { ShellDialect } from '../../shared/os/shellDialect';

/**
 * How a worker (claude / codex / a generic command) is started in a pane, written once and turned into either of the two ways a
 * host starts it (#371):
 *  - a POSIX host: a line typed into the pane's shell ({@link renderLaunchLine});
 *  - a Windows host: the program and its arguments handed to misao's `pane.open`, which starts it without any shell
 *    ({@link launchArgv}). Nothing is quoted, nothing is looked up by a shell, and misao names the pane's profile after the program.
 */

/** One argument of a program. `flag`: written by this codebase (typed as it is); `value`: data (a model name, a user's extra argument), always quoted in a line. */
export interface LaunchArg {
  readonly text: string;
  readonly kind: 'flag' | 'value';
}

export const flag = (text: string): LaunchArg => ({ text, kind: 'flag' });
export const value = (text: string): LaunchArg => ({ text, kind: 'value' });

/** A known program (claude, codex) and its arguments. `env` is set for the program only (a line writes it before the program). */
export interface ProgramLaunch {
  readonly kind: 'program';
  readonly file: string;
  readonly args: readonly LaunchArg[];
  readonly env?: Readonly<Record<string, string>>;
}

/** A command the user wrote as one line (a generic worker, a manually launched window): typed as it is on a POSIX host, split into arguments on a Windows one. */
export interface CommandLineLaunch {
  readonly kind: 'commandLine';
  readonly line: string;
}

export type WorkerLaunch = ProgramLaunch | CommandLineLaunch;

/** The words of `extraArgs` (a Unit's field) as quoted values, split on whitespace. */
export function extraArgValues(extraArgs: string | null | undefined): LaunchArg[] {
  return extraArgs?.trim() ? extraArgs.trim().split(/\s+/).map(value) : [];
}

export function commandLineLaunch(line: string): CommandLineLaunch {
  return { kind: 'commandLine', line };
}

/** `launch` with these flags after its own arguments (a session id: `--session-id <id>`, `resume <id>`). Each is a bare word the caller wrote or validated. */
export function withFlags(launch: WorkerLaunch, flags: readonly string[]): WorkerLaunch {
  if (flags.length === 0) return launch;
  if (launch.kind === 'commandLine') return commandLineLaunch([launch.line, ...flags].join(' '));
  return { ...launch, args: [...launch.args, ...flags.map(flag)] };
}

/** The line that starts `launch` in a pane running `dialect`'s shell. */
export function renderLaunchLine(launch: WorkerLaunch, dialect: ShellDialect): string {
  if (launch.kind === 'commandLine') return launch.line;
  const line = [launch.file, ...launch.args.map((arg) => (arg.kind === 'flag' ? arg.text : dialect.quote(arg.text)))].join(' ');
  return launch.env && Object.keys(launch.env).length > 0 ? dialect.withEnv(launch.env, line) : line;
}

/** The program and its arguments, for a host that starts it without a shell. A command line is split only when that is safe (see {@link splitCommandLine}). */
export function launchArgv(launch: WorkerLaunch): string[] {
  if (launch.kind === 'commandLine') return splitCommandLine(launch.line);
  return [launch.file, ...launch.args.map((arg) => arg.text)];
}

/** The environment the program is started with, apart from the pane's own; empty for a command line (nothing in it can be told apart from its text). */
export function launchEnv(launch: WorkerLaunch): Readonly<Record<string, string>> {
  return launch.kind === 'program' ? launch.env ?? {} : {};
}

/** The name of the program that is started (`claude`, `codex`, the first word of a command line), without directory or extension. */
export function launchProgramName(launch: WorkerLaunch): string {
  const first = launch.kind === 'program' ? launch.file : (launch.line.trim().split(/\s+/)[0] ?? '');
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

// Characters a shell reads as more than text. A line containing one outside single quotes is not split: on a POSIX host it means
// something, so the same text cannot be given to a program as arguments without changing what it says.
const SHELL_SYNTAX = /["`$&|;<>()%^!\r\n]/;

/**
 * Splits a command line into the arguments of a program, for a host without a POSIX shell (Windows). It accepts only plain words and
 * `'single quoted'` words (what this codebase and the Add Window form write); anything a shell would interpret (`"`, `$`, `|`, `;`,
 * `&`, `<`, `>`, parentheses, `%`, `^`, `!`, a backquote, a newline, `\'`) makes it refuse, because guessing the meaning would start a
 * different command than the one written. Inside single quotes everything is text, as in sh.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let current: string | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      if (current !== null) words.push(current);
      current = null;
      i++;
      continue;
    }
    current ??= '';
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw refusal(line, 'it has an unterminated single quote');
      current += line.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '\\' && line[i + 1] === "'") throw refusal(line, "it escapes a quote with a backslash (\\')");
    if (SHELL_SYNTAX.test(ch)) throw refusal(line, `it contains ${JSON.stringify(ch)}, which a shell would interpret`);
    current += ch;
    i++;
  }
  if (current !== null) words.push(current);
  if (words.length === 0) throw refusal(line, 'it is empty');
  return words;
}

function refusal(line: string, reason: string): HostProfileError {
  return new HostProfileError('unsupported_os', `This command cannot be started on a Windows host: ${reason} (${JSON.stringify(line)}). A Windows host starts a program with its arguments, not a shell line, so only plain words and 'single quoted' words are accepted.`);
}
