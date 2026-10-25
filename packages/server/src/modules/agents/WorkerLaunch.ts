import { HostProfileError } from '../../shared/os/hostProfile';
import type { ShellDialect } from '../../shared/os/shellDialect';

/**
 * How a worker (claude / codex / a generic command) is started in a pane, written once and turned into either of the two ways a
 * host starts it (#371):
 *  - a POSIX host: a line typed into the pane's shell ({@link renderLaunchLine});
 *  - a Windows host: the program and its arguments handed to misao's `pane.open`, which starts it without any shell
 *    ({@link launchArgv}). Nothing is quoted, nothing is looked up by a shell, and misao names the pane's profile after the program.
 */

/**
 * One argument of a program. `flag`: written by this codebase (typed as it is); `value`: data (a model name, a user's extra argument),
 * always quoted in a line; `raw`: text a user wrote that a line carries as it is (quotes and spacing included) and an argument list
 * splits on whitespace — only for a launch whose line has always been written that way.
 */
export interface LaunchArg {
  readonly text: string;
  readonly kind: 'flag' | 'value' | 'raw';
}

export const flag = (text: string): LaunchArg => ({ text, kind: 'flag' });
export const value = (text: string): LaunchArg => ({ text, kind: 'value' });
export const raw = (text: string): LaunchArg => ({ text, kind: 'raw' });

/** A known program (claude, codex) and its arguments. */
export interface ProgramLaunch {
  readonly kind: 'program';
  readonly file: string;
  readonly args: readonly LaunchArg[];
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
  return [launch.file, ...launch.args.map((arg) => (arg.kind === 'value' ? dialect.quote(arg.text) : arg.text))].join(' ');
}

/**
 * The program and its arguments, for a host that starts it without a shell (Windows). A command line is split only when that is safe
 * (see {@link splitCommandLine}). Every word must also be safe for `cmd.exe`: the program is usually an npm `.cmd` shim (`claude.cmd`),
 * which Windows runs through cmd.exe, and cmd.exe reads `% ^ & | < > " ! ( )` in an argument again, whoever quoted it (a model name,
 * an extra argument, a word inside single quotes). A word with one is refused rather than started as another command.
 */
export function launchArgv(launch: WorkerLaunch): string[] {
  const argv = launch.kind === 'commandLine' ? splitCommandLine(launch.line) : [launch.file, ...launch.args.flatMap((arg) => (arg.kind === 'raw' ? arg.text.split(/\s+/) : [arg.text]))];
  for (const word of argv) {
    const unsafe = CMD_SPECIAL.exec(word);
    if (unsafe) throw refusal(argv.join(' '), `the word ${JSON.stringify(word)} contains ${JSON.stringify(unsafe[0])}, which cmd.exe (it runs .cmd programs such as claude.cmd) reads again`);
  }
  return argv;
}

const CMD_SPECIAL = /[%^&|<>"!()]/;

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
