import fs from 'fs';
import path from 'path';
import { buildCommandSpec } from '../../shared/exec/commandSpec';
import { powershellDialect, powershellEncodedArgs } from '../../shared/os/shellDialect';
import { isHubPointerVersion, isReleaseTag } from './hubVersion';
import type { PruneReport } from './updateBackend';
import { windowsPowershell, type SpecRunner } from './windowsHubService';

/**
 * Tidying the old version folders of a Windows hub after an update has succeeded (#381 U3). Windows only: the Unix hub keeps the
 * folders it always kept.
 *
 * What stays: the version `current.txt` names, the one it named before this update (the way back), every version a running process
 * uses, and anything under `hub\` whose name is not a version (`.staging-*`, `.env`, `current.txt`, ...), which is not looked at.
 * What goes: a real folder directly under `hub\` named like a version. A link (junction or symlink) is never followed and never
 * removed: a link named like a version is somebody's arrangement, so it is left as it is and logged. Inside a folder that is being
 * removed a link is unlinked itself, its target untouched.
 */

const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const REMOVE_ATTEMPTS = 3;
const REMOVE_RETRY_MS = 250;
const IN_USE_TIMEOUT_MS = 60_000;

export interface HubFolderClassification {
  /** Version-named folders that nothing needs: these are removed. */
  remove: string[];
  /** Version-named folders that stay, and why. */
  keep: Array<{ name: string; why: 'current' | 'previous' | 'in use' }>;
}

/**
 * Which of the names directly under `hub\` are removed. Only a name of the shape of a release tag (`isReleaseTag`: what an update names the
 * folder it extracts) is ever a candidate. `current.txt` may hold wider names (`v1.0.0.bak.old`), but a folder like that is somebody's own and is
 * not touched; every other name is left out of both lists. Names are compared without regard to case, as the file system does.
 */
export function classifyHubFolders(names: readonly string[], versions: { current: string; previous: string; inUse: ReadonlySet<string> }): HubFolderClassification {
  const lower = (value: string): string => value.toLowerCase();
  const inUse = new Set([...versions.inUse].map(lower));
  const result: HubFolderClassification = { remove: [], keep: [] };
  for (const name of names) {
    if (!isReleaseTag(name)) continue;
    if (lower(name) === lower(versions.current)) result.keep.push({ name, why: 'current' });
    else if (lower(name) === lower(versions.previous)) result.keep.push({ name, why: 'previous' });
    else if (inUse.has(lower(name))) result.keep.push({ name, why: 'in use' });
    else result.remove.push(name);
  }
  return result;
}

/**
 * The version folders under any of `hubRoots` that a running process uses: the process's executable or its command line has
 * `<hubRoot>\<version>\...` in it (the hub's node.exe and azito-hub.cjs, the launcher's run.ps1, an update process). A process of any user
 * counts. PowerShell prints only the version names (ASCII), not whole paths, so a code page cannot garble them. Throws when the
 * processes cannot be listed: nothing is removed without knowing.
 */
export async function findHubVersionsInUse(run: SpecRunner, systemRoot: string, hubRoots: readonly string[]): Promise<Set<string>> {
  const q = powershellDialect.quote;
  const alternatives = hubRoots.map((root) => `[regex]::Escape(${q(`${root.replace(/[\\/]+$/, '')}\\`)})`).join(" + '|' + ");
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$roots = ${alternatives}`,
    "$pattern = '(?:' + $roots + ')([^\\\\\"\\s]+)(?=[\\\\\"\\s]|$)'",
    'foreach ($p in @(Get-CimInstance Win32_Process)) {',
    '  $text = "$($p.ExecutablePath)`n$($p.CommandLine)"',
    '  foreach ($m in [regex]::Matches($text, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { "version $($m.Groups[1].Value)" }',
    '}',
  ].join('\n');
  const result = await run(buildCommandSpec(windowsPowershell(systemRoot), powershellEncodedArgs(script), { timeoutMs: IN_USE_TIMEOUT_MS }));
  if (result.exitCode !== 0) throw new Error(`Looking for the version folders in use failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  const found = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const name = /^version (\S+)$/.exec(line.trim())?.[1];
    if (name !== undefined && isHubPointerVersion(name)) found.add(name);
  }
  return found;
}

export interface PruneInput {
  /** `<prefix>\hub`. */
  hubDir: string;
  /** The version the update switched to. */
  current: string;
  /** The version `current.txt` named before this update. */
  previous: string;
  /** The versions a running process uses; asked only when there is a folder that could be removed. */
  versionsInUse: () => Promise<ReadonlySet<string>>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function reasonOf(err: unknown): string {
  const code = codeOf(err);
  const message = err instanceof Error ? err.message : String(err);
  return code === undefined || message.startsWith(code) ? message : `${code}: ${message}`;
}

/** A sharing violation on a file the antivirus is looking at passes in a moment; one that a process holds does not, and is reported. */
async function withRetry(operation: () => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      operation();
      return;
    } catch (err) {
      const code = codeOf(err);
      if (code === 'ENOENT') return;
      if (code === undefined || !TRANSIENT_CODES.has(code) || attempt >= REMOVE_ATTEMPTS) throw err;
      await sleep(REMOVE_RETRY_MS);
    }
  }
}

/** Removes the link itself: a symlink or junction to a folder is taken off with `rmdir`, one to a file with `unlink`; the target is never opened. */
async function removeLink(link: string): Promise<void> {
  await withRetry(() => {
    try {
      fs.unlinkSync(link);
    } catch (err) {
      if (codeOf(err) !== 'EISDIR' && codeOf(err) !== 'EPERM') throw err;
      fs.rmdirSync(link);
    }
  });
}

/** A tree removed by hand so that a link inside is never followed (`lstat` decides, not the type of what the link points at). */
async function removeTree(dir: string): Promise<void> {
  for (const name of fs.readdirSync(dir)) {
    const entry = path.join(dir, name);
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) await removeLink(entry);
    else if (stat.isDirectory()) await removeTree(entry);
    else await withRetry(() => fs.unlinkSync(entry));
  }
  await withRetry(() => fs.rmdirSync(dir));
}

/**
 * Why `<hubDir>\<name>` is not removed although it is named like a version, or undefined when it is a real folder (not a link) whose real
 * path is `<real hub>\<name>`. Checked right before the removal, so a folder swapped for a link since the listing is not followed.
 */
function whyNotARealChild(hubDir: string, name: string): string | undefined {
  const entry = path.join(hubDir, name);
  const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (stat === undefined) return 'it is gone';
  if (stat.isSymbolicLink()) return 'it is a link (junction or symlink), which is left alone';
  if (!stat.isDirectory()) return 'it is not a folder';
  const real = fs.realpathSync.native(entry);
  const expected = path.join(fs.realpathSync.native(hubDir), name);
  const same = process.platform === 'win32' ? real.toLowerCase() === expected.toLowerCase() : real === expected;
  return same ? undefined : `its real path ${real} is not directly under the hub folder`;
}

/**
 * Removes the old version folders. A folder that cannot be removed (a file in it is open, a process uses it) is reported in `failed` and
 * left; the next update tries it again, since every update looks at all folders. What was already removed from it stays removed: a version
 * that is neither current nor the way back is not needed whole.
 */
export async function pruneHubVersions(input: PruneInput): Promise<PruneReport> {
  const report: PruneReport = { removed: [], failed: [], skipped: [] };
  const names = fs.readdirSync(input.hubDir).filter(isReleaseTag);
  const versions = { current: input.current, previous: input.previous };
  if (classifyHubFolders(names, { ...versions, inUse: new Set() }).remove.length === 0) return report;
  // Asked only now, and a failure to ask stops the tidying: a folder that is in use must not be taken for one that is not.
  const { remove, keep } = classifyHubFolders(names, { ...versions, inUse: await input.versionsInUse() });
  for (const kept of keep) if (kept.why === 'in use') report.failed.push({ name: kept.name, reason: 'a running process uses it' });
  for (const name of remove) {
    const refusal = whyNotARealChild(input.hubDir, name);
    if (refusal !== undefined) {
      report.skipped.push({ name, reason: refusal });
      continue;
    }
    try {
      await removeTree(path.join(input.hubDir, name));
      report.removed.push(name);
    } catch (err) {
      report.failed.push({ name, reason: reasonOf(err) });
    }
  }
  return report;
}
