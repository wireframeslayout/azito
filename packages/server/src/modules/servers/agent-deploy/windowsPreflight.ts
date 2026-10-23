import { z } from 'zod';
import { powershellDialect } from '../../../shared/os/shellDialect';

const BEGIN_MARKER = '<<AZITO_PREFLIGHT_BEGIN>>';
const END_MARKER = '<<AZITO_PREFLIGHT_END>>';

/**
 * One PowerShell script (run through the dialect's EncodedCommand, so it is the same under a cmd.exe and a PowerShell login
 * shell) that prints the facts the preflight needs as one JSON line between markers. A missing thing is `null`, not an error.
 * tailscale.exe is looked for on PATH and then in its installer's location, because an SSH session may not have it on PATH.
 */
const WINDOWS_PREFLIGHT_SCRIPT = `
$node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
$nodePath = $null
$nodeVersion = $null
if ($node) {
  $nodePath = $node.Source
  $nodeVersion = @(& $nodePath --version)[0]
}
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue | Select-Object -First 1
$tailscalePath = $null
if ($tailscale) { $tailscalePath = $tailscale.Source }
elseif (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe')) { $tailscalePath = Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe' }
$tailscaleIp = $null
if ($tailscalePath) {
  try { $tailscaleIp = @(& $tailscalePath ip -4 2>$null)[0] } catch { $tailscaleIp = $null }
}
$osVersion = [System.Environment]::OSVersion.Version
$info = [ordered]@{
  nodePath = $nodePath
  nodeVersion = $nodeVersion
  arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  windowsMajor = $osVersion.Major
  windowsBuild = $osVersion.Build
  tailscaleIp = $tailscaleIp
  home = $env:USERPROFILE
}
$global:LASTEXITCODE = 0
Write-Output '${BEGIN_MARKER}'
Write-Output (ConvertTo-Json -InputObject $info -Compress)
Write-Output '${END_MARKER}'
`;

/** The command line to send over SSH: the preflight script as an EncodedCommand. */
export function buildWindowsPreflightCommand(): string {
  return powershellDialect.wrapScript(WINDOWS_PREFLIGHT_SCRIPT);
}

const rawSchema = z.object({
  nodePath: z.string().nullable(),
  nodeVersion: z.string().nullable(),
  arch: z.string(),
  windowsMajor: z.number().int(),
  windowsBuild: z.number().int(),
  tailscaleIp: z.string().nullable(),
  home: z.string().min(1),
});

export interface WindowsPreflightInfo {
  nodePath: string | null;
  /** Without the leading `v`; null = node is not on the host. */
  nodeVersion: string | null;
  /** Lower case as .NET names it: `x64`, `arm64`, `x86`. Only x64 is accepted. */
  arch: string;
  /** `Windows 10` / `Windows 11` (build 22000 and later). */
  windowsVersion: string;
  tailscaleIp: string | null;
  home: string;
}

/** Windows 11 is NT 10.0 like Windows 10; the build number (22000 and later) tells them apart. */
function windowsVersionName(major: number, build: number): string {
  if (major === 10) return build >= 22000 ? 'Windows 11' : 'Windows 10';
  return `Windows NT ${major}`;
}

/** Reads the script's output. Only the text between the markers counts (a banner or profile output may surround it). Throws when it is absent or malformed. */
export function parseWindowsPreflight(output: string): WindowsPreflightInfo {
  const text = output.replace(/\r/g, '');
  const begin = text.indexOf(BEGIN_MARKER);
  const end = begin < 0 ? -1 : text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin < 0 || end < 0) {
    throw new Error(`Could not read the Windows preflight (no result between the markers; got: ${output.trim().slice(0, 300) || 'nothing'}).`);
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
  return {
    nodePath: v.nodePath,
    nodeVersion: v.nodeVersion ? v.nodeVersion.trim().replace(/^v/, '') : null,
    arch: v.arch.toLowerCase(),
    windowsVersion: windowsVersionName(v.windowsMajor, v.windowsBuild),
    tailscaleIp: v.tailscaleIp ? v.tailscaleIp.trim() : null,
    home: v.home,
  };
}

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** What is wrong with the host for installing the agent (empty = fine), in the same words the Unix preflight uses. */
export function checkWindowsPreflight(info: WindowsPreflightInfo): string[] {
  const missing: string[] = [];
  const major = info.nodeVersion ? parseInt(info.nodeVersion.split('.')[0], 10) : NaN;
  if (isNaN(major) || major < 24) {
    missing.push(`Node.js v24+ required (found: ${info.nodeVersion ? `v${info.nodeVersion}` : 'not installed'})`);
  }
  if (info.arch !== 'x64') {
    missing.push(`x86_64 architecture required (found: ${info.arch}; Windows on ARM is not supported)`);
  }
  if (!info.tailscaleIp || !IPV4.test(info.tailscaleIp)) {
    missing.push(`Tailscale IP not found (got: ${info.tailscaleIp || 'empty'}; install Tailscale for Windows and sign in)`);
  }
  return missing;
}
