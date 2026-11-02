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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr h, out uint id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
public static uint ServerProcessId(string name) {
using (var c = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
c.Connect(5000); uint id;
if (!GetNamedPipeServerProcessId(c.SafePipeHandle.DangerousGetHandle(), out id)) throw new System.ComponentModel.Win32Exception();
return id;
}
}
public static string OwnerSid(uint id) {
IntPtr p = OpenProcess(0x1000, false, id); if (p == IntPtr.Zero) return null;
try { IntPtr t; if (!OpenProcessToken(p, 8, out t)) return null;
try { using (var i = new System.Security.Principal.WindowsIdentity(t)) { return i.User.Value; } } finally { CloseHandle(t); }
} finally { CloseHandle(p); }
  }
}
'@`;
