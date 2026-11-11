import { buildCommandSpec } from '../../../shared/exec/commandSpec';
import { WINDOWS_PROCESS_RECORDS } from '../../../shared/os/windowsProcessInfo';
import { powershellDialect, powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { windowsPowershell, type SpecRunner } from '../windowsHubService';

/** Refuse whenever an agent or an interpreter task that could start one cannot be ruled out. */
export function buildMisaoAgentGuardScript(systemRoot: string, misaoExe: string, misaoTaskName: string, excludePid: number, callerPid: number): string {
  const q = powershellDialect.quote;
  return [
    `$misaoTask = ${q(misaoTaskName)}`,
    `$misaoExe = ${q(misaoExe)}`,
    `$systemRoot = ${q(systemRoot.replace(/[\\/]+$/, '') + '\\')}`,
    '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ...WINDOWS_PROCESS_RECORDS,
    "$agent = '(?i)azito-agent\\.(?:cjs|exe)|agent[\\/]+main\\.(?:ts|js)'",
    `$trustedNative = @(${[`${systemRoot.replace(/[\\/]+$/, '')}\\System32\\defrag.exe`, `${systemRoot.replace(/[\\/]+$/, '')}\\System32\\cleanmgr.exe`].map(q).join(',')})`,
    'foreach ($p in @(All)) {',
    `  if ($p.ProcessId -eq ${Math.trunc(excludePid)} -or $p.ProcessId -eq ${Math.trunc(callerPid)}) { continue }`,
    "  if (@('System.exe', 'Idle.exe', 'Registry.exe', 'Memory Compression.exe', 'Secure System.exe') -contains $p.Name) { continue }",
    '  if ($p.CommandLine -match $agent -or $p.Name -eq \'azito-agent.exe\') { Write-Output ("AGENT process " + $p.ProcessId); exit 0 }',
    '  if (-not $p.CommandLine -or -not $p.ExecutablePath -or $p.CommandLine -match \'~[0-9]+\' -or $p.ExecutablePath -match \'~[0-9]+\') { Write-Output ("UNKNOWN process " + $p.ProcessId); exit 0 }',
    "  if ($p.Name -eq 'misao.exe' -and [string]::Equals($p.ExecutablePath, $misaoExe, [StringComparison]::OrdinalIgnoreCase)) { continue }",
    "  if (@('node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'rundll32.exe', 'mshta.exe', 'dllhost.exe') -contains $p.Name -or -not $p.ExecutablePath.StartsWith($systemRoot, [StringComparison]::OrdinalIgnoreCase)) { Write-Output (\"UNKNOWN process \" + $p.ProcessId); exit 0 }",
    '}',
    'function Test-TaskEnumerationAuthority {',
    '  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '}',
    'function Test-TaskListComplete($tasks, $root) {',
    '  $expected = @{}',
    '  foreach ($task in $tasks) { $key = ($task.TaskPath + $task.TaskName).TrimStart([char]92); if (-not $key -or $expected.ContainsKey($key)) { return $false }; $expected[$key] = $true }',
    '  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop',
    '  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }',
    "  $pending = New-Object 'System.Collections.Generic.Stack[string]'",
    '  $pending.Push($root)',
    '  while ($pending.Count -gt 0) {',
    '    foreach ($item in (Get-ChildItem -LiteralPath ($pending.Pop()) -Force -ErrorAction Stop)) {',
    '      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }',
    '      if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }',
    '      $name = $item.FullName.Substring($root.Length).TrimStart([char]92)',
    '      if (-not $expected.ContainsKey($name)) { return $false }',
    '      $expected.Remove($name)',
    '    }',
    '  }',
    '  return $expected.Count -eq 0',
    '}',
    "if (-not (Test-TaskEnumerationAuthority)) { Write-Output 'UNKNOWN task enumeration lacks administrator access'; exit 0 }",
    '$tasks = @(Get-ScheduledTask -ErrorAction Stop)',
    `if (-not (Test-TaskListComplete $tasks ${q(pathForTasks(systemRoot))})) { Write-Output 'UNKNOWN task enumeration is incomplete'; exit 0 }`,
    'foreach ($task in $tasks) {',
    "  if ($task.TaskPath -eq '\\' -and $task.TaskName -eq $misaoTask) { continue }",
    "  $systemAccount = @('SYSTEM', 'NT AUTHORITY\\SYSTEM', 'S-1-5-18', 'LOCAL SERVICE', 'NT AUTHORITY\\LOCAL SERVICE', 'S-1-5-19', 'NETWORK SERVICE', 'NT AUTHORITY\\NETWORK SERVICE', 'S-1-5-20') -contains [string]$task.Principal.UserId",
    '  foreach ($action in @($task.Actions)) {',
    '    $exe = [IO.Path]::GetFileName([string]$action.Execute).ToLowerInvariant()',
    '    $args = [string]$action.Arguments',
    '    if (-not $exe) { Write-Output ("UNKNOWN task " + $task.TaskName); exit 0 }',
    '    $text = "$exe $args"',
    "    if ($text -match '(?i)-EncodedCommand\\s+([A-Za-z0-9+/=]+)') { try { $text += [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) } catch { Write-Output (\"UNKNOWN task \" + $task.TaskName); exit 0 } }",
    '    if ($text -match $agent) { Write-Output ("AGENT task " + $task.TaskName); exit 0 }',
    '    if ($text -match \'~[0-9]+|%[^%]+%\' -or -not $systemAccount -or $trustedNative -notcontains [string]$action.Execute) { Write-Output ("UNKNOWN task " + $task.TaskName); exit 0 }',
    '  }',
    '}',
    "Write-Output 'CLEAR'",
  ].join('\n');
}

function pathForTasks(systemRoot: string): string {
  return `${systemRoot.replace(/[\\/]+$/, '')}\\System32\\Tasks`;
}

/** A malformed answer or a failed Windows query is never treated as absence. */
export async function assertNoWindowsAgent(run: SpecRunner, systemRoot: string, misaoExe: string, misaoTaskName: string, excludePid: number, callerPid: number): Promise<void> {
  const script = buildMisaoAgentGuardScript(systemRoot, misaoExe, misaoTaskName, excludePid, callerPid);
  const result = await run(buildCommandSpec(windowsPowershell(systemRoot), powershellEncodedArgs(script), { timeoutMs: 60_000 }));
  if (result.exitCode !== 0) throw new Error(`Cannot check Windows agents: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  const answer = result.stdout.trim();
  if (answer === 'CLEAR') return;
  if (/^(AGENT|UNKNOWN) (process \d+|task [^\r\n]+)$/.test(answer)) throw new Error(`Windows agent use cannot be excluded (${answer}).`);
  throw new Error('Windows agent use could not be determined.');
}
