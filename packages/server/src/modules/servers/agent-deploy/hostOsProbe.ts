/**
 * The first step of the SSH preflight: which kind of host is this? The login shell of an SSH target is POSIX sh (Linux / macOS),
 * cmd.exe (Windows OpenSSH's default) or PowerShell (Windows with the default shell changed), and nothing about it is known
 * yet. One harmless command is sent whose output differs in all three, so the answer is read, not guessed.
 *
 *   echo AZITO_OS:%OS%:$env:OS
 *
 *   login shell | what it does with the text                                         | output
 *   ------------|----------------------------------------------------------------------|--------------------------------
 *   sh          | `%OS%` stays; `$env` is an unset variable, `:OS` stays               | `AZITO_OS:%OS%::OS`
 *   cmd.exe     | `%OS%` is the environment variable (Windows_NT); `$env:OS` stays     | `AZITO_OS:Windows_NT:$env:OS`
 *   PowerShell  | `%OS%` stays; `$env:OS` is the environment variable                  | `AZITO_OS:%OS%:Windows_NT`
 *
 * The line carrying the `AZITO_OS:` marker is read, so a login banner or profile output around it does not matter. Any other
 * text (a shell that is none of the three, or a failed command) is an error with what was received, never a guess.
 */
export const HOST_OS_PROBE_COMMAND = 'echo AZITO_OS:%OS%:$env:OS';

export type HostOsKind = 'posix' | 'windows';
export type LoginShell = 'sh' | 'cmd' | 'powershell';

export interface HostOsProbeResult {
  os: HostOsKind;
  loginShell: LoginShell;
}

const MARKER_LINE = /^AZITO_OS:(.*)$/m;

const SHELL_BY_OUTPUT: Readonly<Record<string, LoginShell>> = {
  '%OS%::OS': 'sh',
  'Windows_NT:$env:OS': 'cmd',
  '%OS%:Windows_NT': 'powershell',
};

/** Reads the output of {@link HOST_OS_PROBE_COMMAND}. Throws (with the received text) when it is none of the three known shapes. */
export function parseHostOsProbe(output: string): HostOsProbeResult {
  const match = MARKER_LINE.exec(output.replace(/\r/g, ''));
  const loginShell = match ? SHELL_BY_OUTPUT[match[1].trim()] : undefined;
  if (!loginShell) {
    throw new Error(`Could not tell the host's OS: the OS probe answered neither as sh, cmd.exe nor PowerShell (got: ${output.trim() || 'nothing'}).`);
  }
  return { os: loginShell === 'sh' ? 'posix' : 'windows', loginShell };
}
