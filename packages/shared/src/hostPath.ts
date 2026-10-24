import type { HostPlatform } from './hostCapabilities';

/**
 * Path functions for a host's OS, chosen by an argument rather than by the OS this code runs on. Pure string handling with no
 * dependency on Node's `path`, so the browser and the hub use the same code for a path that belongs to another machine.
 *
 * posix gives the same results as `path.posix`, win32 the same as `path.win32` for the cases a stored host path can take:
 * drive paths (`C:\x`), UNC (`\\server\share\x`), rooted (`\x`) and drive-relative (`C:x`), with `\` and `/` both accepted.
 * `server/src/shared/os/hostPath.ts` keeps using Node's `path` (it also needs `resolve`, which depends on the process's
 * working directory); `hostPath.test.ts` pins both implementations to the same results so they cannot drift.
 *
 * Two deliberate differences from Node: nothing here reads a working directory, so `relative` of two relative paths is
 * computed on the paths as written, and device paths (`\\.\`, `\\?\`) are not special-cased (they are refused upstream by
 * `invalidHostPathReason`).
 */
export interface HostPathApi {
  /** The separator the host writes. */
  readonly sep: '/' | '\\';
  join(...parts: string[]): string;
  normalize(p: string): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  isAbsolute(p: string): boolean;
  relative(from: string, to: string): string;
  /** Whether two paths name the same place: normalized, no trailing separator, and case-insensitive on win32. */
  samePath(a: string, b: string): boolean;
}

interface ParsedRoot {
  /** The root as written (`C:\`, `\\srv\share\`, `/`). */
  raw: string;
  /** The root in the host's canonical spelling. */
  canonical: string;
  absolute: boolean;
}

const WIN_SEP = /[\\/]/;
const UNC_ROOT = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/;
const DRIVE_ROOT = /^([A-Za-z]):([\\/])?/;

function parseRoot(platform: HostPlatform, p: string): ParsedRoot {
  if (platform !== 'win32') {
    return p.startsWith('/') ? { raw: '/', canonical: '/', absolute: true } : { raw: '', canonical: '', absolute: false };
  }
  const unc = UNC_ROOT.exec(p);
  if (unc) return { raw: unc[0], canonical: `\\\\${unc[1]}\\${unc[2]}\\`, absolute: true };
  if (p.length > 0 && WIN_SEP.test(p[0])) return { raw: p[0], canonical: '\\', absolute: true };
  const drive = DRIVE_ROOT.exec(p);
  if (drive) {
    const absolute = drive[2] !== undefined;
    return { raw: drive[0], canonical: `${drive[1]}:${absolute ? '\\' : ''}`, absolute };
  }
  return { raw: '', canonical: '', absolute: false };
}

function splitSegments(platform: HostPlatform, rest: string): string[] {
  return rest.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter((s) => s !== '' && s !== '.');
}

function sepOf(platform: HostPlatform): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/';
}

function isSepChar(platform: HostPlatform, ch: string | undefined): boolean {
  return ch === '/' || (platform === 'win32' && ch === '\\');
}

function hasTrailingSep(platform: HostPlatform, p: string): boolean {
  return isSepChar(platform, p[p.length - 1]);
}

function resolveDots(segments: string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment !== '..') {
      out.push(segment);
    } else if (out.length > 0 && out[out.length - 1] !== '..') {
      out.pop();
    } else if (!absolute) {
      out.push('..');
    }
  }
  return out;
}

function normalize(platform: HostPlatform, p: string): string {
  if (p.length === 0) return '.';
  const sep = sepOf(platform);
  const root = parseRoot(platform, p);
  const tail = resolveDots(splitSegments(platform, p.slice(root.raw.length)), root.absolute).join(sep);
  if (tail === '') {
    if (root.canonical === '') return hasTrailingSep(platform, p) ? `.${sep}` : '.';
    // `C:` alone is the drive's working directory: Node spells it `C:.`
    return root.absolute ? root.canonical : `${root.canonical}.`;
  }
  return root.canonical + tail + (hasTrailingSep(platform, p) ? sep : '');
}

function join(platform: HostPlatform, parts: string[]): string {
  const given = parts.filter((part) => part !== '');
  if (given.length === 0) return '.';
  let joined = given.join(sepOf(platform));
  if (platform === 'win32' && !/^[\\/]{2}/.test(given[0])) {
    // A rooted first part followed by a part that begins with a separator must not become a UNC prefix.
    joined = joined.replace(/^[\\/]{2,}/, '\\');
  }
  return normalize(platform, joined);
}

function stripTrailingSeps(platform: HostPlatform, p: string): string {
  let end = p.length;
  while (end > 0 && isSepChar(platform, p[end - 1])) end--;
  return p.slice(0, end);
}

function dirname(platform: HostPlatform, p: string): string {
  if (p.length === 0) return '.';
  const root = parseRoot(platform, p);
  const rest = stripTrailingSeps(platform, p.slice(root.raw.length));
  let last = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (isSepChar(platform, rest[i])) {
      last = i;
      break;
    }
  }
  if (last === -1) return root.raw === '' ? '.' : root.raw;
  return root.raw + stripTrailingSeps(platform, rest.slice(0, last));
}

function basename(platform: HostPlatform, p: string, ext?: string): string {
  const root = parseRoot(platform, p);
  const rest = stripTrailingSeps(platform, p.slice(root.raw.length));
  const segments = rest.split(platform === 'win32' ? /[\\/]/ : /\//);
  const name = segments[segments.length - 1];
  if (ext !== undefined && ext !== '' && name !== ext && name.endsWith(ext)) return name.slice(0, name.length - ext.length);
  return name;
}

function fold(platform: HostPlatform, s: string): string {
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** The normalized path without its trailing separator (a root keeps its own). */
function trimmed(platform: HostPlatform, p: string): string {
  const n = normalize(platform, p);
  const root = parseRoot(platform, n);
  if (n.length > root.canonical.length && hasTrailingSep(platform, n)) return n.slice(0, -1);
  return n;
}

function relative(platform: HostPlatform, from: string, to: string): string {
  const a = trimmed(platform, from);
  const b = trimmed(platform, to);
  const rootA = parseRoot(platform, a);
  const rootB = parseRoot(platform, b);
  // Another drive or share has no relative form: like Node, the target itself comes back.
  if (rootA.absolute !== rootB.absolute || fold(platform, rootA.canonical) !== fold(platform, rootB.canonical)) return b;
  const segA = splitSegments(platform, a.slice(rootA.raw.length));
  const segB = splitSegments(platform, b.slice(rootB.raw.length));
  let common = 0;
  while (common < segA.length && common < segB.length && fold(platform, segA[common]) === fold(platform, segB[common])) common++;
  const up = segA.slice(common).map(() => '..');
  return [...up, ...segB.slice(common)].join(sepOf(platform));
}

/** The path functions of a host's OS. */
export function hostPathFor(platform: HostPlatform): HostPathApi {
  return {
    sep: sepOf(platform),
    join: (...parts) => join(platform, parts),
    normalize: (p) => normalize(platform, p),
    dirname: (p) => dirname(platform, p),
    basename: (p, ext) => basename(platform, p, ext),
    isAbsolute: (p) => parseRoot(platform, p).absolute,
    relative: (from, to) => relative(platform, from, to),
    samePath: (a, b) => fold(platform, trimmed(platform, a)) === fold(platform, trimmed(platform, b)),
  };
}
