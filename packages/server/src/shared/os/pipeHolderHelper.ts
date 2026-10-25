/**
 * Asks Windows (not the pipe: a holder's own answer is not believed) which process serves a named pipe. Compiled in the PowerShell
 * session; nothing is installed. `[AzitoPipeHolder]::ServerProcessId('<pipe name without \\.\pipe\>')` throws when nothing serves the pipe
 * (it waits 5 s) and otherwise returns the pid of the server. Shared by the misao lock's holder check and by the removal of a misao.
 */
export const PIPE_HOLDER_HELPER = `Add-Type -TypeDefinition @'
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
