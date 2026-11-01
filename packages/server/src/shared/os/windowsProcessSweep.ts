import { createHash } from 'node:crypto';
import { powershellDialect } from './shellDialect';
import { WINDOWS_PROCESS_INFO } from './windowsProcessInfo';

export interface ProcessSweepInput {
  /** The program's image name, e.g. `node.exe`. */
  image: string;
  /**
   * One exact argument of the command line (a token: the text between spaces or quotes, not a part of a longer one), which says the
   * process is the one of this install: `--env-file=<agent.env>`, or a named pipe's path.
   */
  argument: string;
  /** What the processes are, for the message of the failure ("An <label> process did not end"). */
  label: string;
  /** Also end the `conhost.exe` that started such a process (the task runs the program under `conhost.exe --headless`). */
  endParentConhost: boolean;
  /** The argument is an EncodedCommand; compare its digest to avoid exceeding the command-line limit. */
  hashEncodedCommand?: boolean;
}

/**
 * A PowerShell script that ends the processes of ONE install and nothing else: an `image` process with `argument` exactly among
 * its arguments, owned by the user the script runs as (the SID is compared; an elevated session does not reach other users'
 * processes). It prints nothing and throws when one of them is still there after 10 s.
 *
 * With `endParentConhost`, the `conhost.exe` above such a process is ended with it, but a process id can be reused once its
 * process has ended, so a parent is taken only if it is a conhost.exe of the same user, created no later than the child, and has
 * the same argument (the task hands its arguments to the conhost, so they are in its command line). A process is identified by its
 * id AND its creation time: the time is checked again just before it is ended, and "has it ended?" asks the same question.
 */
export function buildEndProcessesScript(input: ProcessSweepInput): string {
  const q = powershellDialect.quote;
  return [
    WINDOWS_PROCESS_INFO,
    ...(input.hashEncodedCommand ? [
      `$expectedHash = '${createHash('sha256').update(input.argument, 'ascii').digest('hex')}'`,
      "$pattern = '(?:^|\\s)-EncodedCommand\\s+([A-Za-z0-9+/=]+)(?:\\s|$)'",
      '$sha = [Security.Cryptography.SHA256]::Create()',
    ] : [
      `$envArgument = ${q(input.argument)}`,
      "$pattern = '(^|[\\s\"])' + [regex]::Escape($envArgument) + '([\\s\"]|$)'",
    ]),
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    "function Read-Node($p) { $started = $p.StartTime.ToUniversalTime(); $data = [AzitoProcessList]::Read($p.Id); $owner = [AzitoProcessList]::Owner($p.Id); $current = Get-Process -Id $p.Id -ErrorAction Stop; if ($current.StartTime.ToUniversalTime() -ne $started) { throw 'Process changed while inspected' }; [pscustomobject]@{ ProcessId = $p.Id; Name = $p.ProcessName + '.exe'; CreationDate = $started; ParentProcessId = $data[0]; CommandLine = $data[1]; Owner = $owner } }",
    'function Test-Mine($process) { $process.Owner -eq $me }',
    input.hashEncodedCommand
      ? "function Test-Argument($process) { if (-not $process.CommandLine) { return $false }; if ($process.CommandLine -match $pattern) { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($Matches[1]))).Replace('-', ''); return $hash -eq $expectedHash }; return $false }"
      : 'function Test-Argument($process) { $process.CommandLine -and ($process.CommandLine -match $pattern) }',
    `function Get-AgentNodes { @(Get-Process -Name ${q(input.image.replace(/\.exe$/i, ''))} -ErrorAction SilentlyContinue | ForEach-Object { $candidate = $_; $owner = [AzitoProcessList]::Owner($candidate.Id); if (-not $owner) { if (-not (Get-Process -Id $candidate.Id -ErrorAction SilentlyContinue) -or -not $elevated) { return }; throw "Cannot identify process $($_.Id)" }; if ($owner -ne $me) { return }; $n = try { Read-Node $candidate } catch { if (-not (Get-Process -Id $candidate.Id -ErrorAction SilentlyContinue)) { return }; throw }; if (-not $n.Owner -or -not $n.CommandLine) { throw "Cannot identify process $($n.ProcessId)" }; if ((Test-Argument $n) -and (Test-Mine $n)) { $n } }) }`,
    'function Get-Same($target) { $p = Get-Process -Id $target.Id -ErrorAction SilentlyContinue; if (-not $p) { return }; try { $started = $p.StartTime.ToUniversalTime() } catch { if (-not (Get-Process -Id $target.Id -ErrorAction SilentlyContinue)) { return }; throw }; if ($started -eq $target.Created) { $p } }',

    '$targets = @()',
    'foreach ($node in Get-AgentNodes) {',
    '  $targets += [pscustomobject]@{ Id = $node.ProcessId; Created = $node.CreationDate }',
    ...(input.endParentConhost ? [
      '  $p = Get-Process -Id $node.ParentProcessId -ErrorAction SilentlyContinue; $parent = if ($p -and [AzitoProcessList]::Owner($p.Id) -eq $me) { Read-Node $p } else { $null }',
      "  if ($parent -and $parent.Name -eq 'conhost.exe' -and $parent.CreationDate -le $node.CreationDate -and (Test-Argument $parent) -and (Test-Mine $parent)) {",
      '    $targets += [pscustomobject]@{ Id = $parent.ProcessId; Created = $parent.CreationDate }',
      '  }',
    ] : []),
    '}',
    'foreach ($target in $targets) { if (Get-Same $target) { Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue } }',
    'function Get-Alive { @($targets | Where-Object { Get-Same $_ }) }',
    'for ($i = 0; $i -lt 20 -and (Get-Alive).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }',
    '$left = Get-Alive',
    `if ($left.Count -gt 0) { throw "An ${input.label} process did not end: $(($left | ForEach-Object { $_.Id }) -join ', ')" }`,
  ].join('\n');
}

/** Check for an owned process with an exact command-line argument without stopping it. */
export function buildProcessPresentScript(image: string, argument: string): string {
  const q = powershellDialect.quote;
  return [
    '# AZITO_PROCESS_PRESENT',
    `$arg = ${q(argument)}`,
    "$pattern = '(^|[\\s\"])' + [regex]::Escape($arg) + '([\\s\"]|$)'",
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    WINDOWS_PROCESS_INFO,
    '$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    `$ps = @(Get-Process -Name ${q(image.replace(/\.exe$/i, ''))} -ErrorAction SilentlyContinue)`,
    'foreach ($p in $ps) {',
    '  $owner = [AzitoProcessList]::Owner($p.Id)',
    '  if (-not $owner) { if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) -or -not $elevated) { continue }; throw "Cannot identify process $($p.Id)" }',
    '  if ($owner -ne $me) { continue }',
    '  $started = $p.StartTime.ToUniversalTime(); $data = [AzitoProcessList]::Read($p.Id)',
    '  $current = Get-Process -Id $p.Id -ErrorAction SilentlyContinue; if (-not $current) { continue }',
    '  if ($current.StartTime.ToUniversalTime() -ne $started) { throw "Process changed while inspected" }',
    '  if (-not $data[1]) { throw "Cannot read process command line" }',
    '  if ($data[1] -match $pattern) { Write-Output "present"; exit 0 }',
    '}',
    'Write-Output "absent"',
  ].join('\n');
}

export function parseProcessPresent(output: string): boolean {
  const value = output.trim();
  if (value === 'present') return true;
  if (value === 'absent') return false;
  throw new Error('Cannot determine whether the managed process is present');
}
