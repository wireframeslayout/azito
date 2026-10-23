import { execFileSync } from 'child_process';
import type { CommandResult, CommandSpec } from '../commandSpec';

/** A finished command with exit code 0. */
export function ok(stdout = '', stderr = ''): CommandResult {
  return { exitCode: 0, signal: null, stdout, stderr };
}

/** A finished command with a non-zero exit code. */
export function failed(exitCode: number, stderr = '', stdout = ''): CommandResult {
  return { exitCode, signal: null, stdout, stderr };
}

/** `file arg arg...` on one line, to match a recorded call by its text. Diagnostic only: never run it. */
export function specText(spec: CommandSpec): string {
  return [spec.file, ...spec.args].join(' ');
}

/**
 * What a real POSIX shell makes of the program-and-arguments part of an old `exec(<command line>)` string: the argv it would
 * have started. Pins a migrated call to the old behaviour without writing a shell splitter. `commandLine` must not contain
 * `cd ... &&`, redirections or pipes (those are `cwd`, a result field, or code, and are tested on their own).
 */
export function argvOfShellLine(commandLine: string): string[] {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${commandLine}`], { encoding: 'utf-8' });
  return out.split('\0').slice(0, -1);
}

/** The `[file, ...args]` of a spec: what `argvOfShellLine` returns for the old string. */
export function argvOfSpec(spec: CommandSpec): string[] {
  return [spec.file, ...spec.args];
}

export type RunResponder = (spec: CommandSpec) => CommandResult | Promise<CommandResult>;

/** A transport with only `run`, answered by `respond` (default: exit 0, no output). Every spec it received is in `specs`. */
export function fakeRunTransport(respond: RunResponder = () => ok()): { run: (spec: CommandSpec) => Promise<CommandResult>; specs: CommandSpec[] } {
  const specs: CommandSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return respond(spec);
    },
  };
}
