import { z } from 'zod';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';

const BEGIN_MARKER = '<<AZITO_FIREWALL_BEGIN>>';
const END_MARKER = '<<AZITO_FIREWALL_END>>';

/** Tailscale's address range (CGNAT): the only peers that need to reach the agent, so the rule AZITO adds is limited to it. */
const TAILNET_RANGE = '100.64.0.0/10';

export function firewallRuleName(port: number): string {
  return `AZITO Agent (TCP ${port})`;
}

/** The command a person runs in an Administrator PowerShell to allow the agent's port (also what AZITO runs itself when its session is elevated). */
export function firewallRuleCommand(port: number): string {
  return `New-NetFirewallRule -DisplayName "${firewallRuleName(port)}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress ${TAILNET_RANGE} -Profile Any`;
}

/**
 * One script: reads the enabled inbound Allow rules for TCP `port` or for `nodePath` (the rule Windows itself adds when a person
 * answers its first-run prompt), and when there is none and the session has an elevated token, adds the rule. A host that
 * cannot answer (the NetSecurity module is missing) reports `ruleFound: null`, not a guess.
 */
function buildFirewallScript(port: number, nodePath: string): string {
  const q = powershellDialect.quote;
  return `
$port = ${port}
$node = ${q(nodePath)}
$elevated = ([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$found = $null
$created = $false
$problem = $null
function Test-AllowsInbound($rule) { ("$($rule.Enabled)" -eq 'True') -and ("$($rule.Direction)" -eq 'Inbound') -and ("$($rule.Action)" -eq 'Allow') }
try {
  $byPort = @(Get-NetFirewallPortFilter | Where-Object { "$($_.Protocol)" -eq 'TCP' -and ($_.LocalPort -contains "$port") } | Get-NetFirewallRule | Where-Object { Test-AllowsInbound $_ })
  $byApp = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq $node } | Get-NetFirewallRule | Where-Object { Test-AllowsInbound $_ })
  $found = (($byPort.Count + $byApp.Count) -gt 0)
} catch { $found = $null }
if ($found -eq $false -and $elevated) {
  try {
    $null = New-NetFirewallRule -DisplayName ${q(firewallRuleName(port))} -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress ${q(TAILNET_RANGE)} -Profile Any
    $created = $true
  } catch { $problem = $_.Exception.Message }
}
$info = [ordered]@{ ruleFound = $found; elevated = $elevated; created = $created; problem = $problem }
$global:LASTEXITCODE = 0
Write-Output '${BEGIN_MARKER}'
$json = ConvertTo-Json -InputObject $info -Compress
Write-Output ([regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }))
Write-Output '${END_MARKER}'
`;
}

/** The command line to send over SSH. */
export function buildFirewallCommand(port: number, nodePath: string): string {
  return powershellDialect.wrapScript(buildFirewallScript(port, nodePath));
}

const resultSchema = z.object({
  ruleFound: z.boolean().nullable(),
  elevated: z.boolean(),
  created: z.boolean(),
  problem: z.string().nullable(),
});

export type FirewallResult = z.infer<typeof resultSchema>;

export function parseFirewallResult(stdout: string, stderr: string, code: number): FirewallResult {
  const text = stdout.replace(/\r/g, '');
  const begin = text.indexOf(BEGIN_MARKER);
  const end = begin < 0 ? -1 : text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin < 0 || end < 0) {
    throw new Error(`Could not read the Windows Firewall check (ssh exit ${code}; got: ${redactSecretText(`${stdout.trim()} ${stderr.trim()}`.trim()).slice(0, 300) || 'nothing'})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(begin + BEGIN_MARKER.length, end).trim());
  } catch {
    throw new Error('Could not read the Windows Firewall check (the result is not JSON).');
  }
  const parsed = resultSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Could not read the Windows Firewall check (unexpected result: ${parsed.error.message}).`);
  return parsed.data;
}

/**
 * What stops the install, or null when the agent's port can be reached (a rule exists or was just added) or the host could not
 * say (`ruleFound: null`: the health check that follows is the proof, and it names the firewall when it fails).
 */
export function describeFirewallProblem(result: FirewallResult, port: number): string | null {
  if (result.ruleFound !== false || result.created) return null;
  const how = result.elevated
    ? `AZITO tried to add it and the host refused (${result.problem ?? 'no reason given'}).`
    : 'This SSH session is not elevated (the user is not an administrator, or the session has a filtered token), so AZITO cannot add it.';
  return `Windows Firewall has no enabled inbound rule that allows TCP ${port}, so the hub could not reach the agent. ${how} Run this once in an Administrator PowerShell on the host, then install again:\n  ${firewallRuleCommand(port)}`;
}
