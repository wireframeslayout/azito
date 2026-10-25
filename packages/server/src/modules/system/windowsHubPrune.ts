import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isReleaseTag } from './hubVersion';
import type { PruneReport } from './updateBackend';

/**
 * Tidying the old version folders of a Windows hub after an update has succeeded (#381 U3). Windows only: the Unix hub keeps the
 * folders it always kept.
 *
 * What stays: the version `current.txt` names, the one it named before this update (the way back), every version a running process
 * uses, and anything under `hub\` whose name is not a release tag (`.staging-*`, `.env`, `current.txt`, ...), which is not looked at.
 * What goes: a real folder directly under `hub\` named like a release tag. A link (junction or symlink) under `hub\` is left as it is and
 * logged: it is somebody's arrangement.
 *
 * How a folder goes: it is first RENAMED to `.prune-<tag>-<random>` inside the same `hub\` (isolated: it no longer has a version's name, and
 * nothing that looks for a version finds it), and only then removed by `removeIsolated` (on Windows `cmd.exe /c rd /s /q`, see
 * windowsHubFolderOps.ts, which removes a reparse point inside the tree, mount points included, as the link itself and never enters it).
 * A walk of our own was rejected: Node's `lstat` reports a volume mount point as the folder it points at, and a check followed by a removal
 * is a window for a swap. What is left of the swap is closed by the caller's precondition (`hub\` can be written by its owner only, so
 * nobody else can swap anything). A `.prune-*` that could not be removed is removed by the next update.
 */

const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 250;
/** `.prune-<tag>-<8 hex>`: what {@link pruneHubVersions} renames a folder to, and what a later run picks up again. */
const ISOLATED_NAME = /^\.prune-[0-9A-Za-z.+-]+-[0-9a-f]{8}$/;

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

export interface PruneInput {
  /** `<prefix>\hub`. */
  hubDir: string;
  /** The version the update switched to. */
  current: string;
  /** The version `current.txt` named before this update. */
  previous: string;
  /** The versions a running process uses; asked only when there is a folder that could be removed. Throws when that cannot be told. */
  versionsInUse: () => Promise<ReadonlySet<string>>;
  /** Removes `<hubDir>\<isolatedName>` completely, a reparse point inside it as the link only. Throws when something stays. */
  removeIsolated: (isolatedName: string) => Promise<void>;
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

/** A sharing violation on a folder the antivirus is looking at passes in a moment; one that a process holds does not, and is reported. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = codeOf(err);
      if (code === undefined || !TRANSIENT_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw err;
      await sleep(RENAME_RETRY_MS);
    }
  }
}

/**
 * Why `<hubDir>\<name>` is not removed although it is named like a version, or undefined when it is a real folder (not a link) whose real
 * path is `<real hub>\<name>`. The removal itself never enters a link, so this decides what is reported, not what is safe.
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
 * Removes the old version folders (and the `.prune-*` of an earlier run). A folder that cannot be removed (a file in it is open, a process
 * uses it) is reported in `failed` and left; the next update tries it again, since every update looks at all folders. What was already removed
 * from it stays removed: a version that is neither current nor the way back is not needed whole. Throws only when the in-use list cannot be made.
 */
export async function pruneHubVersions(input: PruneInput): Promise<PruneReport> {
  const report: PruneReport = { removed: [], failed: [], skipped: [] };
  const all = fs.readdirSync(input.hubDir);
  const names = all.filter(isReleaseTag);
  const versions = { current: input.current, previous: input.previous };
  const leftovers = all.filter((name) => ISOLATED_NAME.test(name));
  const hasCandidates = classifyHubFolders(names, { ...versions, inUse: new Set() }).remove.length > 0;
  if (!hasCandidates && leftovers.length === 0) return report;
  // Asked before anything is removed, and a failure to ask stops the tidying: a folder that is in use must not be taken for one that is not.
  const { remove, keep } = hasCandidates
    ? classifyHubFolders(names, { ...versions, inUse: await input.versionsInUse() })
    : { remove: [], keep: [] };
  for (const kept of keep) if (kept.why === 'in use') report.failed.push({ name: kept.name, reason: 'a running process uses it' });
  for (const name of leftovers) await removeOne(input, name, name, report, true);
  for (const name of remove) {
    const refusal = whyNotARealChildSafely(input.hubDir, name);
    if (refusal !== undefined) {
      report.skipped.push({ name, reason: refusal });
      continue;
    }
    const isolated = `.prune-${name}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await renameWithRetry(path.join(input.hubDir, name), path.join(input.hubDir, isolated));
    } catch (err) {
      report.failed.push({ name, reason: `could not be set aside for removal (${reasonOf(err)})` });
      continue;
    }
    await removeOne(input, name, isolated, report, false);
  }
  return report;
}

/** An entry that cannot be examined is a failure of that entry, not of the run: the others still go. */
function whyNotARealChildSafely(hubDir: string, name: string): string | undefined {
  try {
    return whyNotARealChild(hubDir, name);
  } catch (err) {
    return `it could not be examined (${reasonOf(err)})`;
  }
}

/** `verify`: the folder was not made by this run (a `.prune-*` of an earlier one), so it is looked at first: only a real folder is removed. */
async function removeOne(input: PruneInput, name: string, isolated: string, report: PruneReport, verify: boolean): Promise<void> {
  if (verify) {
    const refusal = whyNotARealChildSafely(input.hubDir, isolated);
    if (refusal !== undefined) {
      report.skipped.push({ name: isolated, reason: refusal });
      return;
    }
  }
  try {
    await input.removeIsolated(isolated);
    report.removed.push(name);
  } catch (err) {
    report.failed.push({ name, reason: `${reasonOf(err)} (left as ${isolated}; the next update removes it)` });
  }
}
