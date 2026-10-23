import { powershellDialect } from '../../../shared/os/shellDialect';

const PIPE_PREFIX = '\\\\.\\pipe\\';

/** The compiled helper: connect to the pipe, ask Windows which process serves it, and spell a path in its long form (8.3 short names resolved). Nothing is installed: Add-Type compiles it in the PowerShell session. */
const HELPER = `Add-Type -TypeDefinition @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
public static class AzitoPipe {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint size);
  public static uint ServerProcessId(string name) {
    using (var client = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
      client.Connect(5000);
      uint pid;
      if (!GetNamedPipeServerProcessId(client.SafePipeHandle.DangerousGetHandle(), out pid)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return pid;
    }
  }
  public static string LongPath(string path) {
    var buffer = new StringBuilder(32768);
    uint length = GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
    if (length == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return buffer.ToString();
  }
}
'@`;

/**
 * A PowerShell script that says which program serves the named pipe: it connects to the pipe, gets the SERVER's process id from
 * Windows (`GetNamedPipeServerProcessId`; nothing about command lines is matched, so a lookalike name or case cannot fool it), reads
 * that process's executable path, and prints that path and `expectedExe`, both in their long form, as two base64 (UTF-8) lines.
 */
export function daemonCheckScript(pipe: string, expectedExe: string): string {
  if (!pipe.startsWith(PIPE_PREFIX)) throw new Error(`Not a named pipe path: ${pipe}`);
  const q = powershellDialect.quote;
  return [
    '# AZITO_DAEMON_PATHS',
    HELPER,
    `$name = ${q(pipe.slice(PIPE_PREFIX.length))}`,
    `$expected = ${q(expectedExe)}`,
    '$serverPid = [AzitoPipe]::ServerProcessId($name)',
    '$process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"',
    "if (-not $process -or -not $process.ExecutablePath) { throw \"The process $serverPid that serves the pipe has no readable executable path\" }",
    '$actual = [AzitoPipe]::LongPath($process.ExecutablePath)',
    '$wanted = [AzitoPipe]::LongPath($expected)',
    "foreach ($path in @($actual, $wanted)) { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($path)) }",
  ].join('\n');
}

export interface DaemonCheck {
  actual: string;
  expected: string;
}

/** Reads what {@link daemonCheckScript} printed. */
export function parseDaemonCheck(output: string): DaemonCheck {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length !== 2) throw new Error(`The check of the misao program gave an unexpected answer: ${output.trim().slice(0, 200)}`);
  const [actual, expected] = lines.map((line) => Buffer.from(line, 'base64').toString('utf8'));
  return { actual: actual!, expected: expected! };
}

/** Whether the two paths are the same file name: long forms, compared without regard to case (the file system's own rule). */
export function sameProgram(check: DaemonCheck): boolean {
  return check.actual.toLowerCase() === check.expected.toLowerCase();
}
