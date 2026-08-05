import { promises as fs } from 'fs';
import * as path from 'path';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { assertSafePath } from './assertSafeGitArgs';

// Resolves a path to its real (symlink-free, absolute) form so containment
// checks below cannot be defeated by `..` segments or a symlink that points
// outside the allowed root. Two implementations (local / remote) — see the
// "インターフェースは実装が2つ以上ある場合のみ定義する" rule in AGENTS.md.
export interface IPathResolver {
  /**
   * Resolves `targetPath` to its real absolute path. Must reject (not return
   * a best-effort guess) when the path cannot be resolved — e.g. it does not
   * exist — so callers can fail closed rather than silently allow it through.
   */
  resolveRealPath(targetPath: string): Promise<string>;
}

export class LocalPathResolver implements IPathResolver {
  async resolveRealPath(targetPath: string): Promise<string> {
    return fs.realpath(targetPath);
  }
}

/**
 * Builds the shell path expression for a remote `realpath -e` invocation.
 * `SAFE_PATH_PATTERN` allows a leading `~` (e.g. `~/workspace/repo` is a
 * supported `project_servers.working_directory` form), but single-quoting
 * the whole value never expands it — POSIX shells only expand `~` when it
 * appears unquoted. Splitting `$HOME` out into a double-quoted segment
 * (still expands, but is safe from word-splitting/globbing) and leaving the
 * rest single-quoted preserves the original quoting safety while letting
 * `~` resolve correctly; adjacent quoted segments concatenate into one
 * shell word, so `"$HOME"'/workspace/repo'` is exactly one argument.
 */
function toRemotePathExpr(targetPath: string): string {
  if (targetPath === '~') return '"$HOME"';
  if (targetPath.startsWith('~/')) return `"$HOME"'${targetPath.slice(1)}'`;
  return `'${targetPath}'`;
}

export class RemotePathResolver implements IPathResolver {
  constructor(private transport: IServerTransport) {}

  async resolveRealPath(targetPath: string): Promise<string> {
    assertSafePath(targetPath, 'targetPath');
    // `realpath -e` (GNU coreutils, matches the Linux-only remote/agent server
    // assumption already made elsewhere in this module) requires every path
    // component including the last to exist, so a missing target fails here
    // instead of returning a plausible-looking but unverified path.
    const result = await this.transport.exec(`realpath -e ${toRemotePathExpr(targetPath)}`);
    const resolved = result.stdout.trim();
    if (result.code !== 0 || !resolved) {
      throw new Error(`realpath failed for '${targetPath}'`);
    }
    return resolved;
  }
}

export class PathResolverFactory {
  private localResolver = new LocalPathResolver();

  create(serverType: string, transport?: IServerTransport): IPathResolver {
    if (serverType === 'local') return this.localResolver;
    if (!transport) throw new Error('Transport required for remote path resolution');
    return new RemotePathResolver(transport);
  }
}

/**
 * Judges containment via path.relative() rather than a string prefix match —
 * a prefix match would wrongly accept e.g. `/a/bc` as being under `/a/b`.
 * `resolvedRoot`/`resolvedTarget` must already be real (symlink-resolved,
 * absolute) paths; this function does no resolution of its own.
 */
export function isPathContained(resolvedRoot: string, resolvedTarget: string): boolean {
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves both `targetPath` and `allowedRoot` to real paths and asserts the
 * target is `allowedRoot` itself or strictly beneath it. Fail-fast: any
 * resolution failure (target/root missing, remote lookup error, etc.) is
 * treated as "not contained" — this must never silently let a task run
 * outside its configured directory just because containment couldn't be
 * verified.
 */
export async function assertPathContained(
  resolver: IPathResolver,
  targetPath: string,
  allowedRoot: string,
  label: string,
): Promise<void> {
  let resolvedTarget: string;
  let resolvedRoot: string;
  try {
    [resolvedTarget, resolvedRoot] = await Promise.all([
      resolver.resolveRealPath(targetPath),
      resolver.resolveRealPath(allowedRoot),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot verify ${label} stays within the allowed directory (${message})`);
  }

  if (!isPathContained(resolvedRoot, resolvedTarget)) {
    throw new Error(`${label} escapes the allowed directory`);
  }
}
