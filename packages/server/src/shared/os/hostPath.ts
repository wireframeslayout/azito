import * as path from 'path';
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
  if (rel === '') return true;
  if (api.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + api.sep)) return false;
  if (platform !== 'win32') return true;
  const rootSegments = allowedRoot.split(/[\\/]+/).filter(Boolean);
  const targetSegments = target.split(/[\\/]+/).filter(Boolean);
  return rootSegments.every((segment, i) => targetSegments[i] === segment);
}
