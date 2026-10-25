import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const LIST_MAX_BUFFER = 256 * 1024 * 1024;
const LIST_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 600_000;

/**
 * Why an archive entry's name must not be extracted, or null when it is fine. One rule for every archive a downloaded release comes
 * in (the Unix `.tar.gz` and the Windows `.zip`), read the way the strictest reader would: both separators count (a name from a
 * Windows archive may use `\`), and a leading separator, a drive (`C:`) or a `..` segment would land outside the folder it is
 * extracted into.
 */
export function unsafeEntryReason(entry: string): string | null {
  if (/^[\\/]/.test(entry)) return 'an absolute path';
  if (/^[A-Za-z]:/.test(entry)) return 'a drive path';
  if (entry.split(/[\\/]/).includes('..')) return 'a ".." segment';
  return null;
}

/** Throws on the first entry name that {@link unsafeEntryReason} refuses. */
export function assertSafeEntryNames(entries: readonly string[]): void {
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    const reason = unsafeEntryReason(entry);
    if (reason) throw new Error(`Path traversal detected in archive: ${entry} (${reason})`);
  }
}

/**
 * Throws on a link or a special file in a bsdtar verbose listing (`tar -tvf`: the first character of a line is the entry type, `-`
 * for a file and `d` for a folder; `l` is a symlink, `h` a hard link). A release archive has neither, and a link is how an entry
 * escapes the folder after its name passed the check.
 */
export function assertNoLinkEntries(verboseListing: string): void {
  for (const line of verboseListing.split(/\r?\n/)) {
    if (line === '') continue;
    const type = line[0];
    if (type !== '-' && type !== 'd') throw new Error(`The archive has a link or a special file, which is refused: ${line.trim()}`);
  }
}

export interface ExtractZipOptions {
  /** The `.zip`. */
  archive: string;
  /** The folder to create (`hub\<tag>`); it must not exist. */
  destination: string;
  /** bsdtar by absolute path (`hostTarOf`): GNU tar cannot read a zip. */
  tar: string;
}

/**
 * Unpacks a zip into a new folder, or leaves nothing behind. The entry names and types are checked from `tar` listings before
 * anything is written, the files are unpacked into a work folder beside the destination (same volume, so the last step is one
 * rename), and the work folder is removed whatever happens. An existing destination is never written into or replaced: it stops
 * here with the reason (a caller that wants to re-extract an installed version decides that itself).
 */
export async function extractZipSafely(options: ExtractZipOptions): Promise<void> {
  const { archive, destination, tar } = options;
  if (fs.existsSync(destination)) throw new Error(`${destination} already exists; it is not overwritten`);

  const names = await listEntries(tar, ['-tf', archive], archive);
  if (names.length === 0) throw new Error(`${archive} has no entries`);
  assertSafeEntryNames(names);
  assertNoLinkEntries(await listEntries(tar, ['-tvf', archive], archive).then((lines) => lines.join('\n')));

  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, `.${path.basename(destination)}.extracting-`));
  try {
    try {
      await execFileAsync(tar, ['-xf', archive, '-C', work], { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER });
    } catch (err) {
      throw new Error(`Could not extract ${archive}: ${(err as Error).message}`);
    }
    if (fs.existsSync(destination)) throw new Error(`${destination} appeared while extracting; it is not overwritten`);
    await renameFolder(work, destination);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Windows reports these when something (Defender scanning what was just written, the search indexer) still has a file of the folder open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 300;

/**
 * Renames the finished work folder into place. On Windows the rename of a folder that was written a moment ago can fail while a
 * scanner holds one of its files, and succeeds a moment later, so those codes (and only those, only on Windows) are tried again for a few
 * seconds; any other failure, or the last one, is thrown as it is.
 */
async function renameFolder(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || code === undefined || !TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

async function listEntries(tar: string, args: string[], archive: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(tar, args, { maxBuffer: LIST_MAX_BUFFER, timeout: LIST_TIMEOUT_MS });
    return stdout.split(/\r?\n/).filter((line) => line !== '');
  } catch (err) {
    throw new Error(`Could not read ${archive} as an archive: ${(err as Error).message}`);
  }
}
