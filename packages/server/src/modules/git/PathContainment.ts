import { promises as fs } from 'fs';
import * as path from 'path';
import type { IServerTransport } from '../servers/transport/ServerTransport';

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
    // Unlike git ref/arg values, this string is never interpolated
    // unquoted — `toRemotePathExpr()` always wraps it in single quotes (or
    // the `"$HOME"'...'` form for a leading `~`), so shell metacharacters
    // cannot escape into the command. Applying git's `assertSafePath`
    // (SAFE_PATH_PATTERN) here was therefore only extra restriction, not
    // extra safety, and it rejected legitimate directory names containing
    // `+`, `,`, `=`, or spaces. Only the structural requirements that would
    // break quoting/parsing itself are checked: non-empty, no NUL byte (NUL
    // cannot appear in a POSIX path and would truncate the shell command).
    if (targetPath.length === 0) throw new Error('targetPath must not be empty');
    if (targetPath.includes('\0')) throw new Error('targetPath must not contain a NUL byte');
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
 * Path pair shared by all three containment functions below. Bundling
 * `target`/`allowedRoot` into a named-field object — rather than two
 * adjacent `string` parameters — is the fix for Issue #27 review finding 4:
 * with two bare strings in a row, a caller that swaps their order still
 * type-checks and still passes tests, but silently inverts the security
 * judgment (a legitimate path gets rejected, or worse, a path that should be
 * rejected gets allowed). An object argument makes the swap a visible,
 * grep-able mistake at every call site instead of an invisible one.
 *
 * All three functions use this same `{ target, allowedRoot }` field order —
 * previously `isPathContained(resolvedRoot, resolvedTarget)` took root
 * first while `assertPathContained` took target first, which made the
 * mismatch easier to introduce by copy-paste.
 */
export interface PathContainmentPair {
  target: string;
  allowedRoot: string;
}

/**
 * Judges containment via path.relative() rather than a string prefix match —
 * a prefix match would wrongly accept e.g. `/a/bc` as being under `/a/b`.
 * `target`/`allowedRoot` must already be real (symlink-resolved, absolute)
 * paths; this function does no resolution of its own.
 *
 * The escape check is `rel === '..' || rel.startsWith('..' + path.sep)`, not
 * a bare `rel.startsWith('..')` — the latter also matches legitimate child
 * names that merely start with two dots (e.g. `path.relative('/a/b',
 * '/a/b/..cache')` returns `'..cache'`), which would wrongly reject a real
 * child directory as an escape (Issue #27 review finding 3).
 */
export function isPathContained({ target, allowedRoot }: PathContainmentPair): boolean {
  const rel = path.relative(allowedRoot, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

/**
 * Resolves both `target` and `allowedRoot` to real paths and asserts the
 * target is `allowedRoot` itself or strictly beneath it. Fail-fast: any
 * resolution failure (target/root missing, remote lookup error, etc.) is
 * treated as "not contained" — this must never silently let a task run
 * outside its configured directory just because containment couldn't be
 * verified.
 *
 * Returns the resolved (symlink-free, absolute) target path. Callers must
 * use this returned value — not the original `target` — for anything that
 * follows (worktree creation, `cd`, persistence to the DB). Verifying
 * `target` and then separately using `target` again would leave a TOCTOU
 * window where a symlink swapped in between the two could redirect the
 * later use outside `allowedRoot` even though the check passed
 * (Issue #27 review finding 2).
 */
export async function assertPathContained(
  resolver: IPathResolver,
  { target, allowedRoot }: PathContainmentPair,
  label: string,
): Promise<string> {
  let resolvedTarget: string;
  let resolvedRoot: string;
  try {
    [resolvedTarget, resolvedRoot] = await Promise.all([
      resolver.resolveRealPath(target),
      resolver.resolveRealPath(allowedRoot),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot verify ${label} stays within the allowed directory (${message})`);
  }

  if (!isPathContained({ target: resolvedTarget, allowedRoot: resolvedRoot })) {
    throw new Error(`${label} escapes the allowed directory`);
  }
  return resolvedTarget;
}

/**
 * Shared choke point for "resolve a transport-appropriate path resolver, then
 * verify containment" — the piece every launch/resume/respawn path needs
 * (Issue #27 review finding 1). Previously this wiring lived only as a
 * private method on `ExecuteTaskUseCase`, so `TaskRestoreService` (startup
 * task recovery) and `WindowRespawnService` (pane/window respawn) launched
 * workers into `task.workingDirectory` / `pane.workingDirectory` without any
 * containment check at all.
 *
 * Skips (returns `candidateDir` unchanged, no resolution/verification) when
 * `allowedRoot` is unset — same "no configured boundary to enforce" behavior
 * `ExecuteTaskUseCase` always had, preserved here for every caller.
 */
export async function assertDirectoryContained(
  resolverFactory: PathResolverFactory,
  serverType: string,
  transport: IServerTransport | undefined,
  { target, allowedRoot }: { target: string; allowedRoot: string | null | undefined },
  label: string,
): Promise<string> {
  if (!allowedRoot) return target;
  const resolver = resolverFactory.create(serverType, transport);
  return assertPathContained(resolver, { target, allowedRoot }, label);
}
