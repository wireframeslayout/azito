import { execFile } from 'child_process';
import path from 'path';
import { powershellDialect, powershellEncodedArgs } from '../../../shared/os/shellDialect';
import type { HolderCheck, HolderVerdict } from '../../../shared/processLock';

const PIPE_PREFIX = '\\\\.\\pipe\\';

/** Asks Windows (not the pipe: a holder's own answer is not believed) which process serves a named pipe. Compiled in the PowerShell session; nothing is installed. */
const HELPER = `Add-Type -TypeDefinition @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
public static class AzitoPipeHolder {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);
  public static uint ServerProcessId(string name) {
    using (var client = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
      client.Connect(5000);
      uint pid;
      if (!GetNamedPipeServerProcessId(client.SafePipeHandle.DangerousGetHandle(), out pid)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return pid;
    }
  }
}
'@`;

/**
 * A PowerShell script that prints who holds a named pipe: the pid of the process that serves it (`GetNamedPipeServerProcessId`), the SID
 * of that process's owner (`GetOwnerSid`; empty when Windows does not say) and the SID of whoever runs the script, as `pid=`, `owner=`
 * and `me=` lines.
 */
export function pipeHolderScript(pipe: string): string {
  if (!pipe.startsWith(PIPE_PREFIX)) throw new Error(`Not a named pipe path: ${pipe}`);
  return [
    HELPER,
    `$name = ${powershellDialect.quote(pipe.slice(PIPE_PREFIX.length))}`,
    '$serverPid = [AzitoPipeHolder]::ServerProcessId($name)',
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$owner = \'\'',
    '$process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"',
    // GetOwnerSid reports "access denied" and the like as a non-zero ReturnValue, not as an exception: only ReturnValue 0 with a SID is an answer.
    'if ($process) { try { $r = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop; if ($r.ReturnValue -eq 0 -and $r.Sid -is [string]) { $owner = $r.Sid } } catch { } }',
    '"pid=$serverPid"',
    '"owner=$owner"',
    '"me=$me"',
  ].join('\n');
}

/** What {@link pipeHolderScript} printed, judged: the holder is this user's only when Windows names the same owner SID; a different or unknown owner is not. */
export function judgeHolder(output: string): HolderVerdict {
  const value = (key: string): string | undefined => new RegExp(`^${key}=(.*)$`, 'm').exec(output.replace(/\r/g, ''))?.[1]?.trim();
  const pidText = value('pid');
  const pid = pidText !== undefined && /^\d+$/.test(pidText) ? Number(pidText) : undefined;
  const owner = value('owner');
  const me = value('me');
  if (me === undefined || me === '') return { state: 'unknown', ...(pid !== undefined ? { pid } : {}), reason: 'the SID of this user could not be read' };
  if (pid === undefined) return { state: 'unknown', reason: 'Windows did not say which process serves the pipe' };
  if (owner === undefined || owner === '') return { state: 'unknown', pid, reason: `the owner of process ${pid} could not be read` };
  return owner.toLowerCase() === me.toLowerCase() ? { state: 'same-user', pid } : { state: 'other-user', pid, ownerSid: owner };
}

/** The holder check the lock uses on Windows: runs the script with the PowerShell that ships with it. A script that fails is `unknown` with its message, never "mine". */
export function createPipeHolderCheck(systemRoot: string): HolderCheck {
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return (endpoint) => new Promise<HolderVerdict>((resolve) => {
    execFile(powershell, powershellEncodedArgs(pipeHolderScript(endpoint)), { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ state: 'unknown', reason: (stderr.trim() || err.message).slice(0, 300) });
        return;
      }
      resolve(judgeHolder(stdout));
    });
  });
}
