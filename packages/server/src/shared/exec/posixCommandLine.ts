import { shellQuote } from '../shellQuote';
import { ENV_NAME_PATTERN, type CommandSpec } from './commandSpec';

/**
 * The `/bin/sh -c` text that runs `spec` the way `runCommandSpec` would, for an agent that predates `POST /api/run`
 * (its only way to run a command is `POST /api/exec`, which is a shell). Every value is single-quoted, so the shell
 * splits the line back into exactly `spec.file` and `spec.args`. Used only for an agent whose host was never recorded
 * (a Unix one): the choice is made up front by the transport, never as a retry after `/api/run` failed.
 *
 * Differences a shell cannot hide: a program that cannot be started is exit status 127 / 126 rather than a spawn error,
 * and the timeout is the agent's kill of the shell, which looks like a plain failure.
 */
export function toPosixCommandLine(spec: CommandSpec): string {
  const assignments = Object.entries(spec.env ?? {}).map(([name, value]) => {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
    return `${name}=${shellQuote(value)}`;
  });
  const program = [...assignments, shellQuote(spec.file), ...spec.args.map(shellQuote)].join(' ');
  // No stdin given: it is closed (`runCommandSpec` ends it too), so a program that reads it sees EOF instead of waiting.
  const piped = spec.stdin === undefined ? `${program} </dev/null` : `printf '%s' ${shellQuote(spec.stdin)} | ${program}`;
  return spec.cwd === undefined ? piped : `cd -- ${shellQuote(spec.cwd)} && ${piped}`;
}
