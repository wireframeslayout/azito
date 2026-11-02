import { z } from 'zod';
import { powershellDialect } from '../../../shared/os/shellDialect';
import { redactSecretText } from '../../../shared/redactSecretText';
import { diagnostics } from './hostOsProbe';

const BEGIN_MARKER = '<<AZITO_PREFLIGHT_BEGIN>>';
const END_MARKER = '<<AZITO_PREFLIGHT_END>>';

/**
 * One PowerShell script (run through the dialect's EncodedCommand, so it is the same under a cmd.exe and a PowerShell login
 * shell) that prints the facts the preflight needs as one JSON line between markers. A missing thing is `null`, not an error.
 * tailscale.exe is looked for on PATH and then in its installer's location, because an SSH session may not have it on PATH.
 * The OS architecture comes from the registry because x64-emulated PowerShell reports X64 on Windows on ARM.
 * JSON is ASCII-escaped because a cmd.exe login shell returns output in the OEM code page.
 */
const WINDOWS_PREFLIGHT_SCRIPT = `
$n = Get-Command node -EA SilentlyContinue | Select-Object -First 1
$np = $null
$nv = $null
if ($n) {
$np = $n.Source
$nv = @(& $np --version)[0]
}
$ts = Get-Command tailscale -EA SilentlyContinue | Select-Object -First 1
$tsPath = $null
if ($ts) { $tsPath = $ts.Source }
elseif (Test-Path (Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe')) { $tsPath = Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe' }
$tsIp = $null
$tsCli = 'missing'
$td = $null
$ns = 'not_checked'
$nd = $null
if ($tsPath) {
try {
$pref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$out = @(& $tsPath ip -4 2>&1)
$exit = $LASTEXITCODE
$ErrorActionPreference = $pref
$text = ($out | ForEach-Object { $_.ToString() }) -join ' '
if ($exit -ne 0) {
$tsCli = if ($text -match '\\b401\\b|Unauthorized|already in use by') { 'denied' } else { 'failed' }
$td = "exit $exit : $text"
} else {
$tsIp = @($out | Where-Object { $_ -is [string] } | Select-Object -First 1)[0]
$tsCli = if ($tsIp) { 'ok' } else { 'empty' }
}
} catch {
$ErrorActionPreference = $pref
$tsCli = 'failed'
$td = $_.Exception.Message
}
}
if ($tsCli -eq 'denied') {
try {
$ns = 'empty'
foreach ($a in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
if ($a.OperationalStatus -ne 'Up' -or ($a.Name -notlike 'Tailscale*' -and $a.Description -notlike 'Tailscale*')) { continue }
foreach ($u in $a.GetIPProperties().UnicastAddresses) {
$ip = $u.Address
if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
$bytes = $ip.GetAddressBytes()
if ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127) {
$tsIp = $ip.ToString()
$ns = 'found'
break
}
}
if ($ns -eq 'found') { break }
}
} catch {
$ns = 'failed'
$nd = $_.Exception.Message
}
}
$arch = $null
try { $arch = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name PROCESSOR_ARCHITECTURE -EA Stop).PROCESSOR_ARCHITECTURE } catch { $arch = $null }
$caption = $null
$build = $null
try { $os = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -EA Stop; $build = $os.CurrentBuildNumber; $caption = $os.ProductName } catch { $caption = $null; $build = $null }
$info = [ordered]@{
nodePath = $np
nodeVersion = $nv
arch = $arch
windowsCaption = $caption
buildNumber = $build
tailscaleIp = $tsIp
tailscaleCli = $tsCli
tailscaleDetail = $td
networkStatus = $ns
networkDetail = $nd
home = $env:USERPROFILE
systemRoot = $env:SystemRoot
userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}
$global:LASTEXITCODE = 0
Write-Output '${BEGIN_MARKER}'
$json = ConvertTo-Json -InputObject $info -Compress
Write-Output ([regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }))
Write-Output '${END_MARKER}'
`;

/** The command line to send over SSH: the preflight script as an EncodedCommand. */
export function buildWindowsPreflightCommand(): string {
  // Keep the encoded command comfortably below the Windows command-line limit of 8191 characters.
  return powershellDialect.wrapScript(WINDOWS_PREFLIGHT_SCRIPT);
}

const rawSchema = z.object({
  nodePath: z.string().nullable(),
  nodeVersion: z.string().nullable(),
  arch: z.string().nullable(),
  windowsCaption: z.string().nullable(),
  buildNumber: z.string().nullable(),
  tailscaleIp: z.string().nullable(),
  tailscaleCli: z.enum(['ok', 'empty', 'missing', 'denied', 'failed']),
  tailscaleDetail: z.string().nullable(),
  networkStatus: z.enum(['not_checked', 'found', 'empty', 'failed']),
  networkDetail: z.string().nullable(),
  home: z.string().min(1),
  systemRoot: z.string().min(1),
  userId: z.string().min(1),
});

export interface WindowsPreflightInfo {
  nodePath: string | null;
  /** Without the leading `v`; null = node is not on the host. */
  nodeVersion: string | null;
  /** The OS's native architecture: `x64`, `arm64`, `x86`, or the registry's own word for another; null = unreadable. Only x64 is accepted. */
  arch: string | null;
  /** The OS name as Windows gives it (`Windows 11 Pro`, `Windows Server 2022 Datacenter`), for display only; null = unreadable. */
  windowsVersion: string | null;
  /** The Windows build number (`17763` is Windows 10 1809 / Server 2019); null = unreadable. */
  buildNumber: number | null;
  tailscaleIp: string | null;
  tailscaleCli: z.infer<typeof rawSchema>['tailscaleCli'];
  tailscaleDetail: string | null;
  networkStatus: z.infer<typeof rawSchema>['networkStatus'];
  networkDetail: string | null;
  home: string;
  /** `%SystemRoot%` of the host (where `schtasks.exe` lives). */
  systemRoot: string;
  /** The user the SSH session runs as, `DOMAIN\user` (or `COMPUTER\user`): the user the agent's task is registered for. */
  userId: string;
}

const ARCH_BY_REGISTRY_VALUE: Readonly<Record<string, string>> = { AMD64: 'x64', ARM64: 'arm64', x86: 'x86' };

/** Reads the script's output. Only the text between the markers counts (a banner or profile output may surround it). Throws when it is absent or malformed. */
export function parseWindowsPreflight(output: string, stderr = '', code: number | null = null): WindowsPreflightInfo {
  const text = output.replace(/\r/g, '');
  const begin = text.indexOf(BEGIN_MARKER);
  const end = begin < 0 ? -1 : text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin < 0 || end < 0) {
    throw new Error(`Could not read the Windows preflight (no result between the markers; got: ${redactSecretText(output.trim()).slice(0, 300) || 'nothing'}${diagnostics(stderr, code)}).`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(begin + BEGIN_MARKER.length, end).trim());
  } catch {
    throw new Error('Could not read the Windows preflight (the result is not JSON).');
  }
  const raw = rawSchema.safeParse(json);
  if (!raw.success) throw new Error(`Could not read the Windows preflight (unexpected result: ${raw.error.message}).`);
  const v = raw.data;
  const buildNumber = v.buildNumber && /^\d+$/.test(v.buildNumber.trim()) ? Number(v.buildNumber.trim()) : null;
  const caption = v.windowsCaption ? v.windowsCaption.trim().replace(/^Microsoft\s+/, '') : null;
  return {
    nodePath: v.nodePath,
    nodeVersion: v.nodeVersion ? v.nodeVersion.trim().replace(/^v/, '') : null,
    arch: v.arch === null ? null : (ARCH_BY_REGISTRY_VALUE[v.arch] ?? v.arch),
    windowsVersion: caption && buildNumber !== null && buildNumber >= 22000 ? caption.replace(/^Windows 10\b/, 'Windows 11') : caption,
    buildNumber,
    tailscaleIp: v.tailscaleIp ? v.tailscaleIp.trim() : null,
    tailscaleCli: v.tailscaleCli,
    tailscaleDetail: v.tailscaleDetail ? redactSecretText(v.tailscaleDetail).slice(0, 300) : null,
    networkStatus: v.networkStatus,
    networkDetail: v.networkDetail ? redactSecretText(v.networkDetail).slice(0, 300) : null,
    home: v.home,
    systemRoot: v.systemRoot,
    userId: v.userId,
  };
}

/** Windows 10 1809 / Server 2019: the first build with `conhost.exe --headless` (ConPTY), which keeps the agent's console window from appearing. */
const MIN_WINDOWS_BUILD = 17763;

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** What is wrong with the host for installing the agent (empty = fine), in the same words the Unix preflight uses. */
export function checkWindowsPreflight(info: WindowsPreflightInfo): string[] {
  const missing: string[] = [];
  const major = info.nodeVersion ? parseInt(info.nodeVersion.split('.')[0], 10) : NaN;
  if (isNaN(major) || major < 24) {
    missing.push(`Node.js v24+ required (found: ${info.nodeVersion ? `v${info.nodeVersion}` : 'not installed'})`);
  }
  if (info.arch === null) {
    missing.push('Could not read the OS architecture (HKLM PROCESSOR_ARCHITECTURE); x86_64 is required');
  } else if (info.arch !== 'x64') {
    missing.push(`x86_64 architecture required (found: ${info.arch}; Windows on ARM is not supported)`);
  }
  if (info.buildNumber === null) {
    missing.push(`Could not read the Windows build number; Windows 10 version 1809 (build ${MIN_WINDOWS_BUILD}) or later is required`);
  } else if (info.buildNumber < MIN_WINDOWS_BUILD) {
    missing.push(`Windows 10 version 1809 (build ${MIN_WINDOWS_BUILD}) or later required (found: build ${info.buildNumber}); the agent runs under \`conhost.exe --headless\``);
  }
  if (!info.tailscaleIp || !IPV4.test(info.tailscaleIp)) {
    const guidance = info.tailscaleCli === 'missing' || info.tailscaleCli === 'empty' ? '; install Tailscale for Windows and sign in' : '';
    const network = info.networkStatus === 'not_checked' ? '' : `; network address lookup: ${info.networkStatus}${info.networkDetail ? `: ${info.networkDetail}` : ''}`;
    missing.push(`Tailscale IP not found (${describeTailscaleCli(info)}${network}${guidance})`);
  }
  return missing;
}

export function describeTailscaleCli(info: WindowsPreflightInfo): string {
  const descriptions = { ok: 'CLI returned an invalid IP', empty: 'CLI returned no IP', missing: 'CLI not found', denied: 'CLI access denied for this Windows user (Tailscale may be in use by another user)', failed: 'CLI failed' };
  const invalidIp = info.tailscaleCli === 'ok' && info.tailscaleIp ? ` (${redactSecretText(info.tailscaleIp).slice(0, 300)})` : '';
  return `${descriptions[info.tailscaleCli]}${invalidIp}${info.tailscaleDetail ? `: ${info.tailscaleDetail}` : ''}`;
}
