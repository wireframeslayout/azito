import { z } from 'zod';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';

const DUMP_BEGIN = '<<AZITO_FIREWALL_DUMP_BEGIN>>';
const DUMP_END = '<<AZITO_FIREWALL_DUMP_END>>';
const ADD_BEGIN = '<<AZITO_FIREWALL_ADD_BEGIN>>';
const ADD_END = '<<AZITO_FIREWALL_ADD_END>>';

/** Tailscale's address range (CGNAT): the only peers that need to reach the agent, so the rule AZITO adds is limited to it. */
const TAILNET_RANGE = '100.64.0.0/10';
const TAILNET_LOW = ipv4ToNumber('100.64.0.0')!;
const TAILNET_HIGH = ipv4ToNumber('100.127.255.255')!;

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

// ─── What the host reports ───

/** One enabled inbound rule with the filters that say whom it is about, every value as the text Windows prints. */
export interface FirewallRuleRecord {
  name: string;
  displayName: string;
  /** `Allow` or `Block`. */
  action: string;
  /** `Any`, or a list such as `Public, Private`. */
  profile: string;
  /** A rule for one packaged app / one service / one owner is not about this program. Empty or `Any` = not restricted. */
  package: string;
  owner: string;
  service: string;
  protocol: string;
  localPort: string[];
  program: string;
  remoteAddress: string[];
  localAddress: string[];
}

const ruleSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  action: z.string(),
  profile: z.string(),
  package: z.string(),
  owner: z.string(),
  service: z.string(),
  protocol: z.string(),
  localPort: z.array(z.string()),
  program: z.string(),
  remoteAddress: z.array(z.string()),
  localAddress: z.array(z.string()),
});

const dumpSchema = z.object({
  elevated: z.boolean(),
  /** The network category of the adapter that carries the agent's address (`Public`, `Private`, `DomainAuthenticated`); null = unreadable. */
  networkCategory: z.string().nullable(),
  /** Which policy store the rules were read from: `ActiveStore` (what is in force, group policy included) or `PersistentStore` (local rules only). */
  store: z.string(),
  /** Why the rules could not be read; then `rules` is empty. */
  problem: z.string().nullable(),
  rules: z.array(ruleSchema),
});

export type FirewallDump = z.infer<typeof dumpSchema>;

/**
 * Reads every enabled inbound rule with its filters. The matching is done by {@link evaluateFirewallRules} on this side, where it
 * can be tested and read: the script only collects, so it is short enough for one cmd.exe command line (8191 characters)
 * whatever the host has. The in-force rules (ActiveStore: group policy included) are read when the host lets this session;
 * otherwise the local ones (PersistentStore) and `store` says so.
 */
function buildDumpScript(localAddress: string): string {
  return `
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$networkCategory = $null
$store = 'ActiveStore'
$problem = $null
$rules = @()
try {
  $interfaceIndex = (Get-NetIPAddress -IPAddress ${powershellDialect.quote(localAddress)} -ErrorAction Stop).InterfaceIndex
  $networkCategory = "$((Get-NetConnectionProfile -InterfaceIndex $interfaceIndex -ErrorAction Stop).NetworkCategory)"
} catch { $networkCategory = $null }
function Read-Filters($command, $policyStore) {
  $byRule = @{}
  foreach ($filter in & $command -PolicyStore $policyStore) { $byRule[$filter.InstanceID] = $filter }
  $byRule
}
function Join-Values($values) { @($values | ForEach-Object { "$_" }) }
try {
  try { $null = Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Select-Object -First 1 } catch { $store = 'PersistentStore' }
  $ports = Read-Filters Get-NetFirewallPortFilter $store
  $apps = Read-Filters Get-NetFirewallApplicationFilter $store
  $addresses = Read-Filters Get-NetFirewallAddressFilter $store
  $services = Read-Filters Get-NetFirewallServiceFilter $store
  $rules = @(foreach ($rule in Get-NetFirewallRule -PolicyStore $store -Direction Inbound -Enabled True) {
    $id = $rule.Name
    if ($null -eq $ports[$id] -or $null -eq $apps[$id] -or $null -eq $addresses[$id] -or $null -eq $services[$id]) { continue }
    [ordered]@{ name = "$id"; displayName = "$($rule.DisplayName)"; action = "$($rule.Action)"; profile = "$($rule.Profile)"; package = "$($apps[$id].Package)"; owner = "$($rule.Owner)"; service = "$($services[$id].Service)"; protocol = "$($ports[$id].Protocol)"; localPort = Join-Values $ports[$id].LocalPort; program = "$($apps[$id].Program)"; remoteAddress = Join-Values $addresses[$id].RemoteAddress; localAddress = Join-Values $addresses[$id].LocalAddress }
  })
} catch { $problem = 'reading the rules failed: ' + $_.Exception.Message; $rules = @() }
$info = [ordered]@{ elevated = $elevated; networkCategory = $networkCategory; store = $store; problem = $problem; rules = @($rules) }
$global:LASTEXITCODE = 0
Write-Output '${DUMP_BEGIN}'
$json = ConvertTo-Json -InputObject $info -Compress -Depth 5
Write-Output ([regex]::Replace($json, '[^\\x00-\\x7F]', { param($match) '\\u{0:x4}' -f [int][char]$match.Value }))
Write-Output '${DUMP_END}'
`.replace(/^[ \t]+/gm, '');
}

/** Adds the allow rule (this program, this address, this port, from the tailnet). Run only when the session is elevated. */
function buildAddScript(port: number, nodePath: string, localAddress: string): string {
  const q = powershellDialect.quote;
  return `
$created = $false
$problem = $null
try {
  $null = New-NetFirewallRule -DisplayName ${q(firewallRuleName(port))} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Program ${q(nodePath)} -LocalAddress ${q(localAddress)} -RemoteAddress ${q(TAILNET_RANGE)} -Profile Any
  $created = $true
} catch { $problem = $_.Exception.Message }
$info = [ordered]@{ created = $created; problem = $problem }
$global:LASTEXITCODE = 0
Write-Output '${ADD_BEGIN}'
$json = ConvertTo-Json -InputObject $info -Compress
Write-Output ([regex]::Replace($json, '[^\\x00-\\x7F]', { param($match) '\\u{0:x4}' -f [int][char]$match.Value }))
Write-Output '${ADD_END}'
`.replace(/^[ \t]+/gm, '');
}

export function buildFirewallDumpCommand(localAddress: string): string {
  return powershellDialect.wrapScript(buildDumpScript(localAddress));
}

export function buildFirewallAddCommand(port: number, nodePath: string, localAddress: string): string {
  return powershellDialect.wrapScript(buildAddScript(port, nodePath, localAddress));
}

function parseBetween<T>(schema: z.ZodType<T>, begin: string, end: string, what: string, stdout: string, stderr: string, code: number): T {
  const text = stdout.replace(/\r/g, '');
  const from = text.indexOf(begin);
  const to = from < 0 ? -1 : text.indexOf(end, from + begin.length);
  if (from < 0 || to < 0) {
    throw new Error(`Could not read the ${what} (ssh exit ${code}; got: ${redactSecretText(`${stdout.trim()} ${stderr.trim()}`.trim()).slice(0, 300) || 'nothing'})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(from + begin.length, to).trim());
  } catch {
    throw new Error(`Could not read the ${what} (the result is not JSON).`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`Could not read the ${what} (unexpected result: ${parsed.error.message}).`);
  return parsed.data;
}

export function parseFirewallDump(stdout: string, stderr: string, code: number): FirewallDump {
  return parseBetween(dumpSchema, DUMP_BEGIN, DUMP_END, 'Windows Firewall rules', stdout, stderr, code);
}

export function parseFirewallAdd(stdout: string, stderr: string, code: number): { created: boolean; problem: string | null } {
  return parseBetween(z.object({ created: z.boolean(), problem: z.string().nullable() }), ADD_BEGIN, ADD_END, 'result of adding the Windows Firewall rule', stdout, stderr, code);
}

// ─── Deciding ───

type AddressSpec =
  | { kind: 'any' }
  | { kind: 'range'; low: number; high: number }
  /** `Internet` and the like: a name Windows resolves; only `Internet` is taken to include the tailnet. */
  | { kind: 'keyword'; name: string }
  | { kind: 'other' };

export function ipv4ToNumber(text: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!;
}

/** `Any`, `10.0.0.1`, `10.0.0.0/8`, `10.0.0.0/255.0.0.0`, `10.0.0.1-10.0.0.9`, or a keyword (LocalSubnet, Internet...). IPv6 is `other`. */
export function parseAddressSpec(spec: string): AddressSpec {
  const text = spec.trim();
  if (text === '' || text.toLowerCase() === 'any') return { kind: 'any' };
  if (text.includes(':')) return { kind: 'other' };
  const dash = text.split('-');
  if (dash.length === 2) {
    const low = ipv4ToNumber(dash[0]!);
    const high = ipv4ToNumber(dash[1]!);
    return low !== null && high !== null && low <= high ? { kind: 'range', low, high } : { kind: 'other' };
  }
  const [address, mask] = text.split('/');
  const base = ipv4ToNumber(address!);
  if (base === null) return /^[A-Za-z]+$/.test(text) ? { kind: 'keyword', name: text.toLowerCase() } : { kind: 'other' };
  if (mask === undefined) return { kind: 'range', low: base, high: base };
  let prefix: number;
  if (/^\d+$/.test(mask)) prefix = Number(mask);
  else {
    const maskNumber = ipv4ToNumber(mask);
    if (maskNumber === null) return { kind: 'other' };
    prefix = 32 - Math.log2(2 ** 32 - maskNumber);
    if (!Number.isInteger(prefix)) return { kind: 'other' };
  }
  if (prefix < 0 || prefix > 32) return { kind: 'other' };
  const size = 2 ** (32 - prefix);
  const low = Math.floor(base / size) * size;
  return { kind: 'range', low, high: low + size - 1 };
}

/** Includes the whole tailnet range (what an Allow rule must do to let the hub in). */
function coversTailnet(specs: string[]): boolean {
  return specs.map(parseAddressSpec).some((s) => s.kind === 'any' || (s.kind === 'range' && s.low <= TAILNET_LOW && s.high >= TAILNET_HIGH));
}

/** Can a connection from the tailnet match (what makes a Block rule matter)? `Internet` is taken to include it. */
function touchesTailnet(specs: string[]): boolean {
  return specs.map(parseAddressSpec).some((s) => s.kind === 'any' || (s.kind === 'keyword' && s.name === 'internet') || (s.kind === 'range' && s.low <= TAILNET_HIGH && s.high >= TAILNET_LOW));
}

function containsAddress(specs: string[], address: string): boolean {
  const value = ipv4ToNumber(address);
  return specs.map(parseAddressSpec).some((s) => s.kind === 'any' || (value !== null && s.kind === 'range' && s.low <= value && s.high >= value));
}

type PortSpec = { kind: 'any' } | { kind: 'range'; low: number; high: number } | { kind: 'other' };

function parsePortSpec(spec: string): PortSpec {
  const text = spec.trim();
  if (text === '' || text.toLowerCase() === 'any') return { kind: 'any' };
  const match = /^(\d+)(?:-(\d+))?$/.exec(text);
  if (!match) return { kind: 'other' };
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  return low <= high ? { kind: 'range', low, high } : { kind: 'other' };
}

/** Allow: the port itself or any port. A range such as 3000-3010 is deliberately not read, so it does not count. */
function allowsPort(specs: string[], port: number): boolean {
  return specs.map(parsePortSpec).some((s) => s.kind === 'any' || (s.kind === 'range' && s.low === port && s.high === port));
}

/** Block: any port, or a range that contains the port (a block on part of a range still blocks it). */
function blocksPort(specs: string[], port: number): boolean {
  return specs.map(parsePortSpec).some((s) => s.kind === 'any' || (s.kind === 'range' && s.low <= port && s.high >= port));
}

function isUnrestricted(value: string): boolean {
  return ['', 'any', '*'].includes(value.trim().toLowerCase());
}

function isTcp(rule: FirewallRuleRecord): boolean {
  return ['tcp', 'any', '6'].includes(rule.protocol.trim().toLowerCase());
}

function programMatches(rule: FirewallRuleRecord, nodePath: string): boolean {
  return rule.program.trim().toLowerCase() === 'any' || rule.program.trim().toLowerCase() === nodePath.toLowerCase();
}

/** Windows names its profiles Domain / Private / Public; the network category of an adapter says DomainAuthenticated for Domain. */
function firewallProfileOf(networkCategory: string | null): string | null {
  if (networkCategory === null) return null;
  return networkCategory === 'DomainAuthenticated' ? 'Domain' : networkCategory;
}

function profileIncludes(ruleProfile: string, name: string): boolean {
  return ruleProfile.split(',').map((p) => p.trim().toLowerCase()).some((p) => p === 'any' || p === name.toLowerCase());
}

export interface FirewallTarget {
  port: number;
  nodePath: string;
  localAddress: string;
  /** From {@link FirewallDump.networkCategory}. */
  networkCategory: string | null;
}

export interface FirewallVerdict {
  /** DisplayNames of the enabled inbound Allow rules that let the hub reach the agent (at most 5). */
  allowedBy: string[];
  /** DisplayNames of the enabled inbound Block rules that stop it. */
  blockedBy: string[];
}

/**
 * Decides, for TCP `port` of `nodePath` bound to `localAddress`, which rules matter. A rule for one packaged app, owner or service
 * is skipped. Both kinds must also fit the address the agent listens on, so a rule about another local address does not count.
 * - ALLOW counts only when it covers all of this: TCP or Any; the local port is the port itself or Any (a range does NOT count);
 *   the program is `nodePath` or Any; the remote address is Any or covers the whole tailnet range (a rule narrowed to LocalSubnet
 *   or another network does not reach the hub); the profile includes the Tailscale adapter's profile (when unreadable: Any or Public).
 * - BLOCK counts when it could stop the hub: the port is in its ports (a range that contains it counts) or it blocks any port;
 *   the program is `nodePath` or Any; the remote address is Any, overlaps the tailnet range, or is `Internet`; the profile includes
 *   the adapter's profile or Any (when unreadable: any profile). A Block rule wins over an Allow in Windows Firewall.
 */
export function evaluateFirewallRules(rules: readonly FirewallRuleRecord[], target: FirewallTarget): FirewallVerdict {
  const profile = firewallProfileOf(target.networkCategory);
  const allowedBy: string[] = [];
  const blockedBy: string[] = [];
  for (const rule of rules) {
    if (!isUnrestricted(rule.package) || !isUnrestricted(rule.owner) || !isUnrestricted(rule.service)) continue;
    if (!isTcp(rule) || !programMatches(rule, target.nodePath)) continue;
    if (!containsAddress(rule.localAddress, target.localAddress)) continue;
    const action = rule.action.trim().toLowerCase();
    if (action === 'block') {
      if (blocksPort(rule.localPort, target.port) && touchesTailnet(rule.remoteAddress) && (profile === null || profileIncludes(rule.profile, profile))) blockedBy.push(rule.displayName);
    } else if (action === 'allow') {
      const profileOk = profile === null ? profileIncludes(rule.profile, 'Public') : profileIncludes(rule.profile, profile);
      if (allowsPort(rule.localPort, target.port) && coversTailnet(rule.remoteAddress) && profileOk) allowedBy.push(rule.displayName);
    }
  }
  return { allowedBy: allowedBy.slice(0, 5), blockedBy };
}

// ─── The check ───

export interface FirewallResult {
  /** Whether an enabled inbound rule lets the hub reach the agent; null = the host could not say. */
  ruleFound: boolean | null;
  elevated: boolean;
  /** The rule was added by this check. */
  created: boolean;
  problem: string | null;
  blockedBy: string[];
  allowedBy: string[];
  /** Which policy store was read (`ActiveStore` includes group policy; `PersistentStore` is the local rules only). */
  store: string;
}

/** Runs one command line on the host through its SSH login shell. */
export type FirewallExec = (command: string) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Reads the host's rules, decides, and adds the rule when nothing covers the agent, nothing blocks it and the session is elevated.
 * A host that cannot be read reports `ruleFound: null`, not a guess.
 */
export async function checkFirewall(exec: FirewallExec, port: number, nodePath: string, localAddress: string): Promise<FirewallResult> {
  const dumped = await exec(buildFirewallDumpCommand(localAddress));
  const dump = parseFirewallDump(dumped.stdout, dumped.stderr, dumped.code);
  if (dump.problem !== null) {
    return { ruleFound: null, elevated: dump.elevated, created: false, problem: dump.problem, blockedBy: [], allowedBy: [], store: dump.store };
  }
  const verdict = evaluateFirewallRules(dump.rules, { port, nodePath, localAddress, networkCategory: dump.networkCategory });
  const found = verdict.allowedBy.length > 0;
  const base = { ruleFound: found, elevated: dump.elevated, created: false, problem: null, blockedBy: verdict.blockedBy, allowedBy: verdict.allowedBy, store: dump.store };
  if (found || verdict.blockedBy.length > 0 || !dump.elevated) return base;
  const added = await exec(buildFirewallAddCommand(port, nodePath, localAddress));
  const result = parseFirewallAdd(added.stdout, added.stderr, added.code);
  return { ...base, created: result.created, problem: result.problem };
}

/**
 * What stops the install, or null when the agent's port can be reached (a rule exists or was just added) or the host could not
 * say (`ruleFound: null`: the health check that follows is the proof, and it names the firewall when it fails).
 */
export function describeFirewallProblem(result: FirewallResult, port: number, nodePath: string, localAddress: string): string | null {
  if (result.blockedBy.length > 0) {
    return `Windows Firewall has an enabled inbound Block rule that stops the agent (TCP ${port} / ${nodePath} / ${localAddress}): ${result.blockedBy.map((n) => `"${n}"`).join(', ')}. A Block rule wins over any Allow rule. Remove or disable it (Windows creates one when the first-run firewall prompt is cancelled), then install again.`;
  }
  if (result.ruleFound !== false || result.created) return null;
  const how = result.elevated
    ? `AZITO tried to add it and the host refused (${result.problem ?? 'no reason given'}).`
    : 'This SSH session is not elevated (the user is not an administrator, or the session has a filtered token), so AZITO cannot add it.';
  return `Windows Firewall has no enabled inbound rule that lets the hub reach the agent (TCP ${port} for ${nodePath} on ${localAddress}, from the Tailscale range ${TAILNET_RANGE}, in the profile of the Tailscale adapter; a rule for a port range or one limited to other remote addresses does not count). ${how} Run this once in an Administrator PowerShell on the host, then install again:\n  ${firewallRuleCommand(port, nodePath, localAddress)}`;
}
