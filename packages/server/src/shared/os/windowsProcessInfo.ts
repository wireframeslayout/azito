function buildWindowsProcessInfo(exitState: boolean): string {
  return `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AzitoProcessList {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);${exitState ? '\n  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);' : ''}
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr data, int length, out int returned);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr reserved1, peb, reserved2a, reserved2b, id, parent; }
  [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort length, maximum; public IntPtr buffer; }
  public static string Owner(int id) {
    IntPtr h = OpenProcess(0x1000, false, id);
    if (h == IntPtr.Zero) return null;
    try {
      IntPtr token;
      if (!OpenProcessToken(h, 8, out token)) return null;
      try { using (var identity = new System.Security.Principal.WindowsIdentity(token)) { return identity.User.Value; } }
      finally { CloseHandle(token); }
    } finally { CloseHandle(h); }
  }
${exitState ? `  static object[] Result(IntPtr h, long parent, string command) {
    uint code;
    bool? exited = GetExitCodeProcess(h, out code) ? (bool?)(code != 259) : null;
    return new object[] { parent, command, exited };
  }` : '  static object[] Result(IntPtr h, long parent, string command) { return new object[] { parent, command }; }'}
  public static object[] Read(int id) {
    IntPtr h = OpenProcess(0x1000, false, id);
    if (h == IntPtr.Zero) return new object[] { 0, null${exitState ? ", null" : ""} };
    try {
      int size = Marshal.SizeOf(typeof(Basic)), returned;
      IntPtr data = Marshal.AllocHGlobal(size);
      long parent = 0;
      try { if (NtQueryInformationProcess(h, 0, data, size, out returned) == 0) parent = ((Basic)Marshal.PtrToStructure(data, typeof(Basic))).parent.ToInt64(); }
      finally { Marshal.FreeHGlobal(data); }
      NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out size);
      if (size <= 0 || size > 1048576) return Result(h, parent, null);
      data = Marshal.AllocHGlobal(size);
      try {
        if (NtQueryInformationProcess(h, 60, data, size, out returned) != 0) return Result(h, parent, null);
        var text = (Unicode)Marshal.PtrToStructure(data, typeof(Unicode));
        return Result(h, parent, text.buffer == IntPtr.Zero ? null : Marshal.PtrToStringUni(text.buffer, text.length / 2));
      } finally { Marshal.FreeHGlobal(data); }
    } finally { CloseHandle(h); }
  }
}
'@`.replace(/^ +/gm, '');
}

/** Windows process information helper, compiled within the PowerShell session. */
export const WINDOWS_PROCESS_INFO = buildWindowsProcessInfo(true);

/** Enumerate processes with the field names consumed by Windows uninstall guards. */
export const WINDOWS_PROCESS_RECORDS = [
  WINDOWS_PROCESS_INFO,
  'function Read-Process($p) {',
  '  $started = $null; try { $started = $p.StartTime.ToUniversalTime() } catch { }',
  '  $info = [AzitoProcessList]::Read($p.Id); $exe = $null',
  '  try { $exe = $p.Path } catch { }',
  '  $owner = [AzitoProcessList]::Owner($p.Id); $current = Get-Process -Id $p.Id -ErrorAction SilentlyContinue',
  '  if (-not $current) { return }; if ($started -and $current.StartTime.ToUniversalTime() -ne $started) { throw "Process changed while inspected" }',
  '  if ($started -and $owner -and $info[2] -eq $true) { return }',
  '  if (-not $started) { $info = @(0, $null); $exe = $null; if ($owner -ne $me) { $owner = $null } }',
  "  [pscustomobject]@{ ProcessId = $p.Id; ParentProcessId = $info[0]; Name = $p.ProcessName + '.exe'; ExecutablePath = $exe; CommandLine = $info[1]; CreationDate = $started; OwnerSid = $owner }",
  '}',
  'function All { @(Get-Process -ErrorAction Stop | Where-Object { $_.Id -ne $PID } | ForEach-Object { Read-Process $_ }) }',
];

/** The listener inspection does not use exit state and must fit a Windows command line. */
export const WINDOWS_PROCESS_INFO_FOR_LISTENER = buildWindowsProcessInfo(false);
