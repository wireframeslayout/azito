import { hostPathFor, type HostPathApi, type HostPlatform, type HostPlatformInfo } from '@azito/shared';

// One instance per OS, so a component can list the result in a dependency array without re-running its effect every render.
const APIS: Partial<Record<HostPlatform, HostPathApi>> = {};

function pathApiOf(platform: HostPlatform): HostPathApi {
  return (APIS[platform] ??= hostPathFor(platform));
}

/**
 * The path functions of a server's host OS. `profile` is the server's `hostProfile`: a local server carries the hub's
 * own OS, and an agent whose OS was never recorded (null / absent) is a Unix one, so it gets POSIX rules.
 */
export function serverPathApi(profile: HostPlatformInfo | null | undefined): HostPathApi {
  return pathApiOf(profile?.platform ?? 'linux');
}

/** Whether the host writes `\` (Windows). Everything else about its paths comes from `HostPathApi`. */
function isWindowsApi(api: HostPathApi): boolean {
  return api.sep === '\\';
}

/** `base` + a relative path written with `/` (a git path, a search hit), in the host's own spelling. */
export function joinRelative(api: HostPathApi, base: string, relativePath: string): string {
  return api.join(base, ...relativePath.split('/'));
}

/** The directory that holds `p`, or `root` itself when that is where `p` lives (the tree keys the root by the string it was given). */
export function parentOrRoot(api: HostPathApi, p: string, root: string): string {
  const parent = api.dirname(p);
  return api.samePath(parent, root) ? root : parent;
}

/**
 * The path a file tab is keyed by. POSIX keeps the string as it came (the tab ids stored before this existed stay
 * valid); Windows spells one file one way (`C:/x/a.ts` and `C:\x\a.ts` are the same tab), by its normalized form.
 */
export function fileTabPath(api: HostPathApi, filePath: string): string {
  return isWindowsApi(api) ? api.normalize(filePath) : filePath;
}

/** The name a file tab, preview header etc. shows for `filePath`. */
export function fileDisplayName(api: HostPathApi, filePath: string): string {
  return api.basename(filePath) || filePath;
}

/** `p` ending with the host's separator (a directory a user can keep typing after). */
export function withTrailingSeparator(api: HostPathApi, p: string): string {
  const last = p[p.length - 1];
  return last === '/' || (isWindowsApi(api) && last === '\\') ? p : p + api.sep;
}

/** The part of `value` up to and including its last separator: the directory being completed. */
export function typedDirectoryPrefix(api: HostPathApi, value: string): string {
  let i = value.length - 1;
  while (i >= 0 && value[i] !== '/' && !(isWindowsApi(api) && value[i] === '\\')) i--;
  return value.slice(0, i + 1);
}

/** The entry whose `path` is the same place as `p` on this host (case-insensitive and separator-tolerant on Windows). */
export function findByPath<T extends { path: string }>(api: HostPathApi, items: T[], p: string): T | null {
  return items.find((item) => api.samePath(item.path, p)) ?? null;
}
