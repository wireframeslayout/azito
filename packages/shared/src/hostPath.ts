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
    return root.absolute ? root.canonical : `${root.canonical}.${hasTrailingSep(platform, p) ? sep : ''}`;
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

/** `path.posix.dirname` / `path.win32.dirname`, including what they do with doubled separators and a UNC share root. */
function dirname(platform: HostPlatform, p: string): string {
  const len = p.length;
  if (len === 0) return '.';
  const isSep = (i: number): boolean => isSepChar(platform, p[i]);
  const win = platform === 'win32';
  let rootEnd = -1;
  let offset = 0;
  if (win) {
    if (len === 1) return isSep(0) ? p : '.';
    if (isSep(0)) {
      rootEnd = offset = 1;
      if (isSep(1)) {
        // UNC: \\server\share\
        let j = 2;
        let last = j;
        while (j < len && !isSep(j)) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && isSep(j)) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !isSep(j)) j++;
            if (j === len) return p;
            if (j !== last) rootEnd = offset = j + 1;
          }
        }
      }
    } else if (/^[A-Za-z]:/.test(p)) {
      rootEnd = len > 2 && isSep(2) ? 3 : 2;
      offset = rootEnd;
    }
  } else if (isSep(0)) {
    rootEnd = 1;
  }
  let end = -1;
  let matchedSlash = true;
  for (let i = len - 1; i >= (win ? offset : 1); i--) {
    if (isSep(i)) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) {
    if (win) {
      if (rootEnd === -1) return '.';
      end = rootEnd;
    } else {
      return rootEnd === 1 ? '/' : '.';
    }
  }
  if (!win && rootEnd === 1 && end === 1) return '//';
  return p.slice(0, end);
}

/** `path.basename`: only a drive letter (`C:`) is a prefix; a UNC share root's last part is its name, like Node. */
function basename(platform: HostPlatform, p: string, ext?: string): string {
  // Like Node: a whole path that is the extension has no name left (`basename('foo', 'foo')`), but `basename('/x/foo', 'foo')` is still `foo`.
  if (ext !== undefined && ext !== '' && p === ext) return '';
  const prefix = platform === 'win32' && /^[A-Za-z]:/.test(p) ? 2 : 0;
  const rest = stripTrailingSeps(platform, p.slice(prefix));
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
  // Like Node, a UNC path is compared as `\\` + server + share + ..., so two shares of one server relate by `..`.
  const isUnc = (root: ParsedRoot): boolean => root.canonical.startsWith('\\\\');
  const rootKey = (root: ParsedRoot): string => (isUnc(root) ? root.canonical.slice(0, root.canonical.indexOf('\\', 2) + 1) : root.canonical);
  const segmentsOf = (p: string, root: ParsedRoot): string[] => [
    ...(isUnc(root) ? root.canonical.slice(2).split('\\').filter((x) => x !== '') : []),
    ...splitSegments(platform, p.slice(root.raw.length)),
  ];
  // Another drive or server has no relative form: like Node, the target itself comes back.
  if (rootA.absolute !== rootB.absolute || fold(platform, rootKey(rootA)) !== fold(platform, rootKey(rootB))) return b;
  const segA = segmentsOf(a, rootA);
  const segB = segmentsOf(b, rootB);
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
