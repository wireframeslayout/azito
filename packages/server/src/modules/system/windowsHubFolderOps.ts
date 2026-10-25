import path from 'path';
import { buildCommandSpec } from '../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../shared/os/shellDialect';
import { isHubPointerVersion } from './hubVersion';
import { windowsPowershell, type SpecRunner } from './windowsHubService';

/**
 * What the Windows hub's old-version tidying (windowsHubPrune.ts) asks of the machine: who can write `hub\`, which version folders a process
 * uses, and the removal of a folder. Each is one program run through a `SpecRunner`, so the logic around them is tested without Windows.
 */

const POWERSHELL_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 300_000;

async function powershell(run: SpecRunner, systemRoot: string, script: string, what: string): Promise<string> {
  const result = await run(buildCommandSpec(windowsPowershell(systemRoot), powershellEncodedArgs(script), { timeoutMs: POWERSHELL_TIMEOUT_MS }));
  if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return result.stdout;
}

// ── who can write hub\ ───────────────────────────────────────────────────

/** SIDs that may write `hub\` without it being a reason to stop: this user, SYSTEM, Administrators, the owner placeholder, TrustedInstaller. */
const ALWAYS_TRUSTED_SIDS = ['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'];
/** WriteData, AppendData, DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership, GenericWrite, GenericAll: what swaps or replaces a folder. */
const WRITE_RIGHTS = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

export interface HubDirAcl {
  me: string;
  owner: string;
  allows: Array<{ sid: string; rights: number }>;
}

export function parseHubDirAcl(output: string): HubDirAcl {
  const acl: HubDirAcl = { me: '', owner: '', allows: [] };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const me = /^me (S-[0-9-]+)$/.exec(line);
    const owner = /^owner (S-[0-9-]+)$/.exec(line);
    const allow = /^allow (S-[0-9-]+) (-?\d+)$/.exec(line);
    if (me) acl.me = me[1];
    else if (owner) acl.owner = owner[1];
    else if (allow) acl.allows.push({ sid: allow[1], rights: Number(allow[2]) });
  }
  if (acl.me === '' || acl.owner === '') throw new Error('Could not read the access list of the hub folder');
  return acl;
}

/**
 * The reason `hub\` is not a folder only its owner can change, or undefined when it is. Someone who can write there could swap a version
 * folder for a link between the tidying's check and its removal, so the tidying is not done at all then. This user, SYSTEM and Administrators
 * can always change it (they can do anything to this user's files anyway) and are not counted.
 */
export function whyHubDirIsWritableByOthers(acl: HubDirAcl): string | undefined {
  const trusted = new Set([acl.me, ...ALWAYS_TRUSTED_SIDS]);
  if (acl.owner !== acl.me && acl.owner !== 'S-1-5-32-544') return `the hub folder is owned by ${acl.owner}, not by this user`;
  const others = acl.allows.filter((e) => !trusted.has(e.sid) && (e.rights & WRITE_RIGHTS) !== 0).map((e) => e.sid);
  return others.length === 0 ? undefined : `the hub folder can be changed by others (${[...new Set(others)].join(', ')})`;
}

/** Throws with the reason when `hubDir` can be changed by anyone but its owner (and SYSTEM / Administrators). */
export async function assertHubDirOnlyOwnerWritable(run: SpecRunner, systemRoot: string, hubDir: string): Promise<void> {
  const q = powershellDialect.quote;
  const script = [
    '$acl = [IO.Directory]::GetAccessControl(' + q(hubDir) + ')',
    'Write-Output "me $([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"',
    'Write-Output "owner $($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value)"',
    'foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { if ($r.AccessControlType -eq \'Allow\') { Write-Output "allow $($r.IdentityReference.Value) $([int]$r.FileSystemRights)" } }',
  ].join('\n');
  const why = whyHubDirIsWritableByOthers(parseHubDirAcl(await powershell(run, systemRoot, script, 'Reading the access list of the hub folder')));
  if (why !== undefined) throw new Error(`${why}, so the old versions are not removed`);
}

// ── which versions a process uses ────────────────────────────────────────

/** Reads the answer of the in-use script: the versions found, and the processes whose use could not be told. Throws on the latter. */
export function parseVersionsInUse(output: string): Set<string> {
  const found = new Set<string>();
  const unknown: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const version = /^version (\S+)$/.exec(line)?.[1];
    if (version !== undefined && isHubPointerVersion(version)) found.add(version);
    const missing = /^unknown (\d+) (\S+)$/.exec(line);
    if (missing) unknown.push(`${missing[1]} (${missing[2]})`);
  }
  if (unknown.length > 0) {
    throw new Error(`Cannot tell whether process ${unknown.join(', ')} uses an old version (its path is not readable), so no old version is removed`);
  }
  return found;
}

/** A regex (as text) for `<hubRoot>\` that takes either slash and any run of them between the parts. */
function rootPattern(root: string): string {
  const escape = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `${root.split(/[\\/]+/).filter((part) => part !== '').map(escape).join('[\\\\/]+')}[\\\\/]+`;
}

/** Programs that run a file they are given (so the file may be in a version folder): their command line must be known. */
const INTERPRETERS = ['node.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'python.exe'];

/** `QueryFullProcessImageName` with the least right, compiled in the PowerShell session (nothing is installed). */
const IMAGE_HELPER = `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AzitoImage {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  public static string PathOf(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var name = new StringBuilder(32768);
      uint size = (uint)name.Capacity;
      return QueryFullProcessImageNameW(h, 0, name, ref size) ? name.ToString() : null;
    } finally { CloseHandle(h); }
  }
}
'@`;

/**
 * The version folders under any of `hubRoots` that a running process uses: the process's executable or its command line has
 * `<hubRoot>\<version>\...` in it (the hub's node.exe and azito-hub.cjs, the launcher's run.ps1, an update process). A process of any user
 * counts. A process whose use cannot be ruled out (its image path is unknown even to the least-right query, or it is an
 * interpreter with no readable command line) stops the tidying, whoever it belongs to: reading and running a version needs no write right.
 * Its image path is asked again with the least right (`QueryFullProcessImageName`); when that is known and is not a program that runs files it
 * is given (`INTERPRETERS`), the missing command line does not matter (protected system and antivirus components have none). One that is gone by
 * the time it is looked at is not counted. PowerShell prints only version names (ASCII), so a code page cannot garble them.
 */
export async function findHubVersionsInUse(run: SpecRunner, systemRoot: string, hubRoots: readonly string[]): Promise<Set<string>> {
  const q = powershellDialect.quote;
  const pattern = `(?:${hubRoots.map(rootPattern).join('|')})([^\\\\/"\\s]+)(?=[\\\\/"\\s]|$)`;
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    IMAGE_HELPER,
    `$pattern = ${q(pattern)}`,
    `$interpreters = @(${INTERPRETERS.map((n) => q(n)).join(', ')})`,
    'foreach ($p in @(Get-CimInstance Win32_Process)) {',
    '  $path = $p.ExecutablePath',
    '  $cmd = $p.CommandLine',
    '  $hit = $false',
    '  foreach ($m in [regex]::Matches("$path`n$cmd", $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { "version $($m.Groups[1].Value)"; $hit = $true }',
    '  if ($hit -or ($path -and $cmd) -or $p.ProcessId -eq 0 -or $p.ProcessId -eq 4) { continue }',
    '  $live = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue',
    '  if (-not $live) { continue }',
    // The image path again, by the call that needs the least right (PROCESS_QUERY_LIMITED_INFORMATION): it works for many processes WMI gives no path for.
    '  $image = $path',
    '  if (-not $image) {',
    '    $image = [AzitoImage]::PathOf([uint32]$p.ProcessId)',
    '    foreach ($m in [regex]::Matches("$image", $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { "version $($m.Groups[1].Value)"; $hit = $true }',
    '  }',
    '  if ($hit) { continue }',
    // A program that runs files it is given needs its command line to be known; any other program whose image is outside the hub folders does not use a version.
    '  if ($image -and ($interpreters -notcontains [IO.Path]::GetFileName($image).ToLowerInvariant())) { continue }',
    // The kernel's own processes have no image file at all (no name here ends in .exe), so they cannot be running a version.
    "  if (@('System', 'Registry', 'Memory Compression', 'Secure System', 'vmmem', 'vmmemWSL') -contains $p.Name) { continue }",
    "  $name = ($p.Name -replace '[^A-Za-z0-9._-]', '_')",
    // Whoever the process belongs to: a read-and-run use of a version needs no write right, so the ACL of hub\ does not clear it.
    '  "unknown $($p.ProcessId) $name"',
    '}',
  ].join('\n');
  return parseVersionsInUse(await powershell(run, systemRoot, script, 'Looking for the version folders in use'));
}

// ── removing a folder ────────────────────────────────────────────────────

/**
 * Removes `<hubDir>\<name>` with `cmd.exe /d /c rd /s /q <name>` (cmd.exe by its absolute path, run in `hubDir` so that the argument is a plain
 * name). `rd` removes a reparse point inside the tree (a junction, a symlink, a volume mount point) as the link only and does not enter it; Node's
 * own removal cannot be told that (its `lstat` shows a mount point as the folder it points at). `name` is one of our `.prune-*` names, never a path.
 * Throws when the exit code is not 0 or the folder is still there (`stillExists`).
 */
export async function removeFolderWithRd(run: SpecRunner, systemRoot: string, hubDir: string, name: string, stillExists: (folder: string) => boolean): Promise<void> {
  if (!/^[0-9A-Za-z.+-]+$/.test(name)) throw new Error(`Not a plain folder name: ${name}`);
  const cmd = path.win32.join(systemRoot, 'System32', 'cmd.exe');
  const result = await run(buildCommandSpec(cmd, ['/d', '/c', 'rd', '/s', '/q', name], { cwd: hubDir, timeoutMs: REMOVE_TIMEOUT_MS }));
  const folder = path.win32.join(hubDir, name);
  if (result.exitCode !== 0 || stillExists(folder)) {
    throw new Error(`rd could not remove ${name} (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}
