import { gzipSync, gunzipSync } from 'node:zlib';

/** Attach the launcher to a job before starting any children. Windows closes its job handle on launcher exit. */
export const KILL_CHILDREN_JOB = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AzitoTaskJob {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr p, int s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static void Start() {
    IntPtr j=CreateJobObject(IntPtr.Zero,null), p=Marshal.AllocHGlobal(144);
    try {
      for(int i=0;i<144;i+=8) Marshal.WriteInt64(p,i,0);
      Marshal.WriteInt32(p,16,0x2000);
      if(j==IntPtr.Zero || !SetInformationJobObject(j,9,p,144) || !AssignProcessToJobObject(j,GetCurrentProcess()))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
[AzitoTaskJob]::Start()
`;

/** Keep the encoded action below the Windows command-line limit even for user paths with spaces. */
export function compressedTaskScript(script: string): string {
  const data = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  return `$azitoTaskGzip='${data}'\n$z=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String($azitoTaskGzip)),[IO.Compression.CompressionMode]::Decompress)\n$r=[IO.StreamReader]::new($z,[Text.Encoding]::UTF8)\nInvoke-Expression $r.ReadToEnd()`;
}

/** Decode only our bounded gzip wrapper; malformed or oversized definitions are not recognised. */
export function decodedTaskScript(encoded: string): string | undefined {
  const outer = Buffer.from(encoded, 'base64').toString('utf16le');
  const match = /^\$azitoTaskGzip='([A-Za-z0-9+/=]+)'$/m.exec(outer);
  if (!match) return outer;
  try {
    return gunzipSync(Buffer.from(match[1]!, 'base64'), { maxOutputLength: 128 * 1024 }).toString('utf8');
  } catch {
    return undefined;
  }
}
