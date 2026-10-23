import { z } from 'zod';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';

const BEGIN_MARKER = '<<AZITO_FIREWALL_BEGIN>>';
const END_MARKER = '<<AZITO_FIREWALL_END>>';

/** Tailscale's address range (CGNAT): the only peers that need to reach the agent, so the rule AZITO adds is limited to it. */
const TAILNET_RANGE = '100.64.0.0/10';
/** How Windows reads that range back from a rule's address filter. */
const TAILNET_RANGE_READBACK = '100.64.0.0/255.192.0.0';

export function firewallRuleName(port: number): string {
  return `AZITO Agent (TCP ${port})`;
}

/**
 * The command a person runs in an Administrator PowerShell to allow the agent (also what AZITO runs itself when its session is
 * elevated): this program, on the Tailscale address the agent binds to, from the tailnet, on its port only.
 */
export function firewallRuleCommand(port: number, nodePath: string, localAddress: string): string {
  return `New-NetFirewallRule -DisplayName "${firewallRuleName(port)}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Program "${nodePath}" -LocalAddress ${localAddress} -RemoteAddress ${TAILNET_RANGE} -Profile Any`;
}

/**
 * One script. It reads every enabled inbound rule with its port, program and address filters (one bulk read of each filter
 * kind) and decides, for TCP `port` of `nodePath` bound to `ip`:
 * - ALLOW counts only when the rule covers all of this: protocol TCP or Any; the local port is the port itself or Any (a range
 *   such as 3000-3010 is NOT read, so it does not count); the program is `nodePath` or Any; the remote address is Any or the
 *   tailnet range (a rule narrowed to LocalSubnet, one host... does not reach the hub, so it does not count); the local
 *   address is Any or `ip`. The profile is not looked at.
 * - BLOCK counts when it names the port (or Any port) for `nodePath` / any program, or names `nodePath` for TCP. A Block wins
 *   over an Allow in Windows Firewall, so its DisplayName is reported and nothing is added beside it.
 * When there is no covering Allow and no Block, and the session has an elevated token, the rule is added. A host that cannot answer
 * (the NetSecurity module is missing) reports `ruleFound: null`, not a guess.
 */
function buildFirewallScript(port: number, nodePath: string, localAddress: string): string {
  const q = powershellDialect.quote;
  return `
$port = ${port}
$node = ${q(nodePath)}
$ip = ${q(localAddress)}
$ours = @('${TAILNET_RANGE}', '${TAILNET_RANGE_READBACK}')
$elevated = ([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$found = $null
$blocked = @()
$created = $false
$problem = $null
try {
  $ports = @{}; foreach ($f in Get-NetFirewallPortFilter) { $ports[$f.InstanceID] = $f }
  $apps = @{}; foreach ($f in Get-NetFirewallApplicationFilter) { $apps[$f.InstanceID] = $f }
  $addrs = @{}; foreach ($f in Get-NetFirewallAddressFilter) { $addrs[$f.InstanceID] = $f }
  $allow = $false
  foreach ($r in Get-NetFirewallRule -Direction Inbound -Enabled True) {
    $pf = $ports[$r.Name]; $af = $apps[$r.Name]; $ad = $addrs[$r.Name]
    if ($null -eq $pf -or $null -eq $af -or $null -eq $ad) { continue }
    $lp = @($pf.LocalPort | ForEach-Object { "$_" })
    $tcp = ("$($pf.Protocol)" -eq 'TCP') -or ("$($pf.Protocol)" -eq 'Any')
    $portNamed = $tcp -and ($lp -contains "$port")
    $portAny = $tcp -and ($lp -contains 'Any')
    $progNamed = ("$($af.Program)" -ieq $node)
    $progAny = ("$($af.Program)" -ieq 'Any')
    if ("$($r.Action)" -eq 'Block') {
      if ((($portNamed -or $portAny) -and $progNamed) -or ($portNamed -and $progAny) -or ($tcp -and $progNamed)) { $blocked += $r.DisplayName }
    } elseif ("$($r.Action)" -eq 'Allow') {
      $remote = @($ad.RemoteAddress | ForEach-Object { "$_" })
      $local = @($ad.LocalAddress | ForEach-Object { "$_" })
      $remoteOk = ($remote -contains 'Any') -or (@($remote | Where-Object { $ours -contains $_ }).Count -gt 0)
      $localOk = ($local -contains 'Any') -or ($local -contains $ip)
      if (($portNamed -or $portAny) -and ($progNamed -or $progAny) -and $remoteOk -and $localOk) { $allow = $true }
    }
  }
  $found = $allow
} catch { $found = $null }
if ($found -eq $false -and $elevated -and $blocked.Count -eq 0) {
  try {
    $null = New-NetFirewallRule -DisplayName ${q(firewallRuleName(port))} -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Program $node -LocalAddress $ip -RemoteAddress ${q(TAILNET_RANGE)} -Profile Any
    $created = $true
  } catch { $problem = $_.Exception.Message }
}
$info = [ordered]@{ ruleFound = $found; elevated = $elevated; created = $created; problem = $problem; blockedBy = @($blocked) }
$global:LASTEXITCODE = 0
Write-Output '${BEGIN_MARKER}'
$json = ConvertTo-Json -InputObject $info -Compress
Write-Output ([regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }))
Write-Output '${END_MARKER}'
`;
}

/** The command line to send over SSH. */
export function buildFirewallCommand(port: number, nodePath: string, localAddress: string): string {
  return powershellDialect.wrapScript(buildFirewallScript(port, nodePath, localAddress));
}

const resultSchema = z.object({
  ruleFound: z.boolean().nullable(),
  elevated: z.boolean(),
  created: z.boolean(),
  problem: z.string().nullable(),
  /** DisplayNames of enabled inbound Block rules that stop the agent's port or program. */
  blockedBy: z.array(z.string()),
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
export function describeFirewallProblem(result: FirewallResult, port: number, nodePath: string, localAddress: string): string | null {
  if (result.blockedBy.length > 0) {
    return `Windows Firewall has an enabled inbound Block rule that stops the agent (TCP ${port} / ${nodePath}): ${result.blockedBy.map((n) => `"${n}"`).join(', ')}. A Block rule wins over any Allow rule. Remove or disable it (Windows creates one when the first-run firewall prompt is cancelled), then install again.`;
  }
  if (result.ruleFound !== false || result.created) return null;
  const how = result.elevated
    ? `AZITO tried to add it and the host refused (${result.problem ?? 'no reason given'}).`
    : 'This SSH session is not elevated (the user is not an administrator, or the session has a filtered token), so AZITO cannot add it.';
  return `Windows Firewall has no enabled inbound rule that lets the hub reach the agent (TCP ${port} for ${nodePath} on ${localAddress}, from the Tailscale range ${TAILNET_RANGE}; a rule for a port range or one limited to other remote addresses does not count). ${how} Run this once in an Administrator PowerShell on the host, then install again:\n  ${firewallRuleCommand(port, nodePath, localAddress)}`;
}
