import fs from 'fs';
import { isHubPointerVersion } from './hubVersion';

/**
 * `<prefix>\hub\current.txt`, the pointer a Windows hub update switches (the Unix `current` symlink's counterpart). One line: the
 * version folder under `hub\` to run, as install.ps1 writes it: UTF-8, no BOM, `<tag>\r\n`. Three readers depend on that exact form:
 * azito.cmd (`findstr /x` on the line, then `set /p`), the Task Scheduler launcher (`ReadAllText().Trim()` then a regex) and
 * install.ps1. Reading here is stricter than they are (they tolerate a BOM or spaces by trimming; this refuses them) so that a
 * pointer in a form azito.cmd would refuse is found with its reason, not later.
 */
export class HubPointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubPointerError';
  }
}

/** The text to write for a version: `<tag>\r\n`. */
export function formatHubPointer(version: string): string {
  if (!isHubPointerVersion(version)) throw new HubPointerError(`Not a version such as v0.12.0: '${version}'`);
  return `${version}\r\n`;
}

/** The version a pointer's content holds; throws {@link HubPointerError} with the reason when it is not exactly `<tag>\r\n`. */
export function parseHubPointer(content: Buffer): string {
  if (content.length === 0) throw new HubPointerError('current.txt is empty');
  if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) throw new HubPointerError('current.txt starts with a UTF-8 BOM');
  if ((content[0] === 0xff && content[1] === 0xfe) || (content[0] === 0xfe && content[1] === 0xff) || content.includes(0)) {
    throw new HubPointerError('current.txt is not ASCII text (UTF-16?)');
  }
  const text = content.toString('utf8');
  if (!text.endsWith('\r\n')) throw new HubPointerError('current.txt must end with a CRLF line ending after the version');
  const version = text.slice(0, -2);
  if (/[\r\n]/.test(version)) throw new HubPointerError('current.txt must hold exactly one line');
  if (version !== version.trim()) throw new HubPointerError(`current.txt has spaces around the version ('${version}')`);
  if (!isHubPointerVersion(version)) throw new HubPointerError(`current.txt does not hold a version such as v0.12.0 (it holds '${version}')`);
  return version;
}

/** Reads the pointer file. A missing file is the caller's to handle (`ENOENT` propagates); a malformed one is a {@link HubPointerError}. */
export function readHubPointer(pointerFile: string): string {
  return parseHubPointer(fs.readFileSync(pointerFile));
}

/**
 * Writes the pointer so a reader never sees a half-written or missing file: the content goes to a file beside it (flushed to disk),
 * which then replaces the pointer in one rename. On Windows Node's rename replaces an existing file (MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING), the counterpart of install.ps1's `File.Replace`. If a reader holds the pointer open without sharing
 * delete the rename fails and the error propagates: the temporary file is removed and the old pointer stays.
 */
export function writeHubPointer(pointerFile: string, version: string): void {
  const content = formatHubPointer(version);
  const tmp = `${pointerFile}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, Buffer.from(content, 'utf8'));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, pointerFile);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
