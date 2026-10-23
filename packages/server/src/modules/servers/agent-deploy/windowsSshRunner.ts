import { z } from 'zod';
import type { CommandSpec } from '../../../shared/exec/commandSpec';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { joinWindowsArgs } from '../../../shared/os/taskScheduler/windowsCommandLine';
import type { CommandSpecRunner, RawCommandResult } from '../../../shared/os/taskScheduler/schtasks';
import { redactSecretText } from '../../../shared/redactSecretText';

/** One command line run on the Windows host through its SSH login shell (cmd.exe or PowerShell), with a time limit for the whole call. */
export type RemoteExec = (command: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number }>;

const BEGIN_MARKER = '<<AZITO_RUN_BEGIN>>';
const END_MARKER = '<<AZITO_RUN_END>>';
/** Connecting and starting powershell.exe take time beyond the program's own deadline. */
const SSH_OVERHEAD_MS = 30_000;

/**
 * Runs `spec.file` with `spec.args` on the host (no shell: `Process.Start` with `UseShellExecute = false`) and prints the exit
 * code and both output streams as BYTES in base64 between markers, so the output survives the SSH session's own text encoding
 * (schtasks writes the OEM code page, which a UTF-8 text channel would garble before it could be decoded).
 */
function buildRunScript(spec: CommandSpec): string {
  const q = powershellDialect.quote;
  return `
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = ${q(spec.file)}
$psi.Arguments = ${q(joinWindowsArgs(spec.args))}
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$so = New-Object System.IO.MemoryStream
$se = New-Object System.IO.MemoryStream
$t1 = $proc.StandardOutput.BaseStream.CopyToAsync($so)
$t2 = $proc.StandardError.BaseStream.CopyToAsync($se)
$proc.WaitForExit()
$t1.Wait()
$t2.Wait()
$r = [ordered]@{ exitCode = $proc.ExitCode; stdout = [Convert]::ToBase64String($so.ToArray()); stderr = [Convert]::ToBase64String($se.ToArray()) }
$global:LASTEXITCODE = 0
Write-Output '${BEGIN_MARKER}'
Write-Output (ConvertTo-Json -InputObject $r -Compress)
Write-Output '${END_MARKER}'
`;
}

const resultSchema = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });

/** Reads what {@link buildRunScript} printed. Throws, with the (redacted) output, when the markers or the JSON are missing. */
export function parseRunOutput(stdout: string, stderr: string, code: number): RawCommandResult {
  const text = stdout.replace(/\r/g, '');
  const begin = text.indexOf(BEGIN_MARKER);
  const end = begin < 0 ? -1 : text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin < 0 || end < 0) {
    throw new Error(`The command on the Windows host gave no result (ssh exit ${code}; got: ${redactSecretText(`${stdout.trim()} ${stderr.trim()}`.trim()).slice(0, 300) || 'nothing'})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(begin + BEGIN_MARKER.length, end).trim());
  } catch {
    throw new Error('The command on the Windows host gave a result that is not JSON');
  }
  const parsed = resultSchema.safeParse(json);
  if (!parsed.success) throw new Error(`The command on the Windows host gave an unexpected result: ${parsed.error.message}`);
  return { exitCode: parsed.data.exitCode, stdout: Buffer.from(parsed.data.stdout, 'base64'), stderr: Buffer.from(parsed.data.stderr, 'base64') };
}

/**
 * A {@link CommandSpecRunner} that runs the program on the Windows host `exec` reaches, so `SchtasksClient` (and its OEM
 * code page decoding) works against another machine. The spec's `cwd`, `env` and `stdin` are not carried: a spec using them is refused.
 */
export function createSshCommandSpecRunner(exec: RemoteExec): CommandSpecRunner {
  return async (spec) => {
    if (spec.cwd !== undefined || spec.env !== undefined || spec.stdin !== undefined) {
      throw new Error('The SSH command runner does not support cwd, env or stdin');
    }
    const result = await exec(powershellDialect.wrapScript(buildRunScript(spec)), spec.timeoutMs + SSH_OVERHEAD_MS);
    return parseRunOutput(result.stdout, result.stderr, result.code);
  };
}
