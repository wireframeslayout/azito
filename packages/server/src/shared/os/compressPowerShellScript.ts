import { gzipSync } from 'node:zlib';

/** Compress a script to fit a Windows SSH command line. */
export function compressPowerShellScript(script: string): string {
  const encoded = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  return [
    `$packed = [Convert]::FromBase64String('${encoded}')`,
    '$stream = New-Object IO.Compression.GzipStream((New-Object IO.MemoryStream(,$packed)), [IO.Compression.CompressionMode]::Decompress)',
    '$reader = New-Object IO.StreamReader($stream); try { Invoke-Expression $reader.ReadToEnd() } finally { $reader.Dispose() }',
  ].join('\n');
}
