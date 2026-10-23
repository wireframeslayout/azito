import { powershellDialect } from './shellDialect';

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
  /** A process id that is never ended even when it matches: the process running this very sweep (the hub's own `azito service stop` names the same program file). */
  excludePid?: number;
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
  const exclusion = input.excludePid === undefined ? '' : ` -and $_.ProcessId -ne ${Math.trunc(input.excludePid)}`;
  return [
    `$envArgument = ${q(input.argument)}`,
    "$pattern = '(^|[\\s\"])' + [regex]::Escape($envArgument) + '([\\s\"]|$)'",
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    'function Test-Mine($process) { try { (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $me } catch { $false } }',
    'function Test-Argument($process) { $process.CommandLine -and ($process.CommandLine -match $pattern) }',
    `function Get-AgentNodes { @(Get-CimInstance Win32_Process -Filter "Name = ${q(input.image)}" | Where-Object { (Test-Argument $_) -and (Test-Mine $_)${exclusion} }) }`,
    'function Get-Same($target) { $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.Id)"; if ($current -and $current.CreationDate -eq $target.Created) { $current } }',
    '$targets = @()',
    'foreach ($node in Get-AgentNodes) {',
    '  $targets += [pscustomobject]@{ Id = $node.ProcessId; Created = $node.CreationDate }',
    ...(input.endParentConhost ? [
      '  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($node.ParentProcessId)"',
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
