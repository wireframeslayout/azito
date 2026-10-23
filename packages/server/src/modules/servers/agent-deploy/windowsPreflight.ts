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
# The native architecture of the OS from the registry: an x64-emulated PowerShell on Windows on ARM still reports X64 through
# RuntimeInformation.OSArchitecture and $env:PROCESSOR_ARCHITECTURE, but this machine-wide value is the OS's own. Unreadable = null (refused with a reason).
$arch = $null
try { $arch = (Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE } catch { $arch = $null }
$caption = $null
try { $caption = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).Caption } catch { $caption = $null }
$info = [ordered]@{
  nodePath = $nodePath
  nodeVersion = $nodeVersion
  arch = $arch
  windowsCaption = $caption
  tailscaleIp = $tailscaleIp
  home = $env:USERPROFILE
}
$global:LASTEXITCODE = 0
Write-Output '${BEGIN_MARKER}'
# ASCII only: a cmd.exe login shell returns the output in the OEM code page, which would garble a non-ASCII user name or path.
$json = ConvertTo-Json -InputObject $info -Compress
Write-Output ([regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }))
Write-Output '${END_MARKER}'
`;

/** The command line to send over SSH: the preflight script as an EncodedCommand. */
export function buildWindowsPreflightCommand(): string {
  return powershellDialect.wrapScript(WINDOWS_PREFLIGHT_SCRIPT);
}

const rawSchema = z.object({
  nodePath: z.string().nullable(),
  nodeVersion: z.string().nullable(),
  arch: z.string().nullable(),
  windowsCaption: z.string().nullable(),
  tailscaleIp: z.string().nullable(),
  home: z.string().min(1),
});

export interface WindowsPreflightInfo {
  nodePath: string | null;
  /** Without the leading `v`; null = node is not on the host. */
  nodeVersion: string | null;
  /** The OS's native architecture: `x64`, `arm64`, `x86`, or the registry's own word for another; null = unreadable. Only x64 is accepted. */
  arch: string | null;
  /** The OS name as Windows gives it (`Windows 11 Pro`, `Windows Server 2022 Datacenter`), for display only; null = unreadable. */
  windowsVersion: string | null;
  tailscaleIp: string | null;
  home: string;
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
  return {
    nodePath: v.nodePath,
    nodeVersion: v.nodeVersion ? v.nodeVersion.trim().replace(/^v/, '') : null,
    arch: v.arch === null ? null : (ARCH_BY_REGISTRY_VALUE[v.arch] ?? v.arch),
    windowsVersion: v.windowsCaption ? v.windowsCaption.trim().replace(/^Microsoft\s+/, '') : null,
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
  if (info.arch === null) {
    missing.push('Could not read the OS architecture (HKLM PROCESSOR_ARCHITECTURE); x86_64 is required');
  } else if (info.arch !== 'x64') {
    missing.push(`x86_64 architecture required (found: ${info.arch}; Windows on ARM is not supported)`);
  }
  if (!info.tailscaleIp || !IPV4.test(info.tailscaleIp)) {
    missing.push(`Tailscale IP not found (got: ${info.tailscaleIp || 'empty'}; install Tailscale for Windows and sign in)`);
  }
  return missing;
}
