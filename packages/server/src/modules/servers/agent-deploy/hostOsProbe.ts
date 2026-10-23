import { redactSecretText } from '../../../shared/redactSecretText';
/**
 * The first step of the SSH preflight: which kind of host is this? The login shell of an SSH target is POSIX sh (Linux / macOS),
 * cmd.exe (Windows OpenSSH's default) or PowerShell (Windows with the default shell changed), and nothing about it is known
 * yet. One harmless command is sent whose output differs in all three, so the answer is read, not guessed.
 *
 *   echo AZITO_OS:%OS%:$?
 *
 *   login shell | what it does with the text                                         | output
 *   ------------|----------------------------------------------------------------------|-----------------------------
 *   sh          | `%OS%` stays; `$?` is the exit status of the previous command (0)    | `AZITO_OS:%OS%:0`
 *   cmd.exe     | `%OS%` is the environment variable (Windows_NT); `$?` stays          | `AZITO_OS:Windows_NT:$?`
 *   PowerShell  | `%OS%` stays; `$?` is the success of the previous command            | `AZITO_OS:%OS%:True`
 *
 * `$?` is always defined, so unlike a variable name it works under `set -u` and cannot be shadowed by the user's own variable.
 * In sh it is the status of whatever ran last (a profile may end with a failure), so any number is read; PowerShell's is True / False.
 *
 * The line carrying the `AZITO_OS:` marker is read, so a login banner or profile output around it does not matter. Any other
 * text (a shell that is none of the three, or a failed command) is an error with what was received, never a guess.
 */
export const HOST_OS_PROBE_COMMAND = 'echo AZITO_OS:%OS%:$?';

export type HostOsKind = 'posix' | 'windows';
export type LoginShell = 'sh' | 'cmd' | 'powershell';

export interface HostOsProbeResult {
  os: HostOsKind;
  loginShell: LoginShell;
}

const MARKER_LINE = /^AZITO_OS:(.*)$/m;

/** The text after `AZITO_OS:` for each login shell (see the table above). */
const SHELL_PATTERNS: ReadonlyArray<readonly [LoginShell, RegExp]> = [
  ['sh', /^%OS%:\d+$/],
  ['cmd', /^Windows_NT:\$\?$/],
  ['powershell', /^%OS%:(True|False)$/],
];

/** Reads the output of {@link HOST_OS_PROBE_COMMAND}. Throws (with the received text) when it is none of the three known shapes. */
export function parseHostOsProbe(output: string, stderr = '', code: number | null = null): HostOsProbeResult {
  const match = MARKER_LINE.exec(output.replace(/\r/g, ''));
  const answer = match?.[1].trim();
  const loginShell = answer === undefined ? undefined : SHELL_PATTERNS.find(([, pattern]) => pattern.test(answer))?.[0];
  if (!loginShell) {
    throw new Error(`Could not tell the host's OS: the OS probe answered neither as sh, cmd.exe nor PowerShell (got: ${redactSecretText(output.trim()) || 'nothing'}${diagnostics(stderr, code)}).`);
  }
  return { os: loginShell === 'sh' ? 'posix' : 'windows', loginShell };
}

/** What the command printed to stderr (the start of it) and its exit code, for an error message: a failed shell says why only there. */
export function diagnostics(stderr: string, code: number | null): string {
  const err = redactSecretText(stderr.trim()).slice(0, 300);
  return `${err ? `; stderr: ${err}` : ''}${code === null ? '' : `; exit code ${code}`}`;
}
