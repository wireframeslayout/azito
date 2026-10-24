import * as path from 'path';
import { hostPathFor } from '@azito/shared';
import type { HostPlatform } from './hostEnv';

export type HostPathApi = typeof path.posix;

/**
 * The path rules of a host's OS (`path.posix` / `path.win32`), whichever OS this process runs on. A path of another host
 * is a plain string; it is only ever handled through the API of that host's platform.
 */
export function pathApiFor(platform: HostPlatform): HostPathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

const DEVICE_PATH = /^[\\/]{2}[.?][\\/]|^[\\/]\?\?[\\/]/;
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Why a path given to a file operation is refused before the host is touched, or null when it is acceptable. Pure, so a
 * Windows host's rules are checked on any OS:
 * - every host: an empty path or one with a NUL byte;
 * - win32: a device path (`\\.\`, `\\?\`), a drive-relative path (`C:foo`, relative to a per-drive working directory) and an
 *   alternate data stream (a `:` anywhere after the drive letter).
 */
export function invalidHostPathReason(platform: HostPlatform, input: string): string | null {
  if (input === '') return 'the path is empty';
  if (input.includes('\0')) return 'the path contains a NUL byte';
  if (platform !== 'win32') return null;
  if (DEVICE_PATH.test(input)) return 'device paths (\\\\.\\ and \\\\?\\) are not allowed';
  if (DRIVE_RELATIVE.test(input)) return 'a drive-relative path (C:foo) is not allowed';
  const rest = DRIVE_PREFIX.test(input) ? input.slice(2) : input;
  if (rest.includes(':')) return 'an alternate data stream (a ":" in a name) is not allowed';
  return null;
}

/** `~`, `~/x`, and on win32 also `~\x`: the home directory of the host's user, expanded by the code that runs on that host. */
export function isHomeRelativePath(platform: HostPlatform, input: string): boolean {
  if (input === '~' || input.startsWith('~/')) return true;
  return platform === 'win32' && input.startsWith('~\\');
}

const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
// A win32 working directory names its drive (or UNC share): `\work` and `/work` would follow the process's current drive.
const WIN32_FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/;

/**
 * Why a stored working directory (a project server's, a task's) is refused, or null when it is acceptable: the file-operation
 * rules of {@link invalidHostPathReason}, no control character on any OS (a follow-up types the path into a pane, where Ctrl-U
 * or a line break would run another command), then an absolute path of the host (on win32 with its drive or UNC share) or a `~`
 * form. A relative path would be resolved against whatever directory the next command happens to run in. Only new input is
 * checked; a value already in the database is never run through this.
 */
export function invalidWorkingDirectoryReason(platform: HostPlatform, input: string): string | null {
  const reason = invalidHostPathReason(platform, input);
  if (reason) return reason;
  if (CONTROL_CHARACTER.test(input)) return 'the path contains a control character';
  if (isHomeRelativePath(platform, input)) return null;
  if (platform === 'win32') {
    return WIN32_FULLY_QUALIFIED.test(input) ? null : 'the path must start with a drive (C:\\) or a UNC share (or ~)';
  }
  return hostPathFor(platform).isAbsolute(input) ? null : 'the path must be absolute (or start with ~)';
}

/**
 * Whether `target` is `allowedRoot` or beneath it. Both must already be real, absolute paths of the host (see
 * `IFileOps.realpath`); no resolution happens here. The verdict is `relative()` of the host's path API (another drive or
 * UNC share comes back absolute, an escape starts with `..`), plus, on win32, an exact-case comparison of the segments:
 * `path.win32.relative` folds case, but a directory may be case-sensitive there, and `Proj` is then not `proj`.
 * A child that merely starts with two dots (`..cache`) is not an escape.
 */
export function isHostPathContained(platform: HostPlatform, { target, allowedRoot }: { target: string; allowedRoot: string }): boolean {
  const api = pathApiFor(platform);
  const rel = api.relative(allowedRoot, target);
  if (rel !== '' && (api.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + api.sep))) return false;
  if (platform !== 'win32') return true;
  // Both in the same fully qualified form (a rooted path without a drive gets the current one), so their segments line up.
  const rootSegments = api.resolve(allowedRoot).split(/[\\/]+/).filter(Boolean);
  const targetSegments = api.resolve(target).split(/[\\/]+/).filter(Boolean);
  return rootSegments.every((segment, i) => targetSegments[i] === segment);
}
