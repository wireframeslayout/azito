import { promises as fs } from 'fs';
import * as path from 'path';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { shellQuote } from '../../shared/shellQuote';

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
 * Builds the shell path expression for a remote `cd -- <path> && pwd -P`
 * invocation. Quoting the whole value never expands a leading `~` (e.g.
 * `~/workspace/repo` is a supported `project_servers.working_directory`
 * form) — POSIX shells only expand `~` when it appears unquoted. Splitting
 * `$HOME` out into a double-quoted segment (still expands, but is safe from
 * word-splitting/globbing) and running the remainder through `shellQuote()`
 * (single-quote escaping, `'` -> `'\''`) preserves quoting safety while
 * letting `~` resolve correctly; adjacent quoted segments concatenate into
 * one shell word, so `"$HOME"'/workspace/repo'` is exactly one argument.
 * Every fragment must go through `shellQuote()` — a bare `'...'` wrap does
 * not escape a `'` inside `targetPath` and lets the value break out of the
 * quotes (Issue #27, critical: shell injection via
 * `project_servers.working_directory` / `windows.working_directory`).
 */
function toRemotePathExpr(targetPath: string): string {
  if (targetPath === '~') return '"$HOME"';
  if (targetPath.startsWith('~/')) return `"$HOME"${shellQuote(targetPath.slice(1))}`;
  return shellQuote(targetPath);
}

export class RemotePathResolver implements IPathResolver {
  constructor(private transport: IServerTransport) {}

  async resolveRealPath(targetPath: string): Promise<string> {
    // Unlike git ref/arg values, this string is never interpolated
    // unquoted — `toRemotePathExpr()` always wraps it in single quotes (or
    // the `"$HOME"'...'` form for a leading `~`), so shell metacharacters
    // cannot escape into the command. Only the structural requirements that
    // would break quoting/parsing itself are checked: non-empty, no NUL
    // byte (NUL cannot appear in a POSIX path and would truncate the shell
    // command).
    if (targetPath.length === 0) throw new Error('targetPath must not be empty');
    if (targetPath.includes('\0')) throw new Error('targetPath must not contain a NUL byte');
    // `pwd -P`'s stdout is trimmed of only its trailing line terminator below
    // (not `.trim()`, which would also eat legitimate leading/trailing
    // whitespace from the resolved path itself). A path containing CR/LF
    // cannot be told apart from the terminator that ends the command's
    // output, so there is no way to recover it unambiguously from transport
    // stdout — reject it here rather than risk stripping real path bytes.
    if (/\r|\n/.test(targetPath)) {
      throw new Error('targetPath must not contain a line terminator');
    }
    // `realpath -e` is GNU coreutils only — the BSD/macOS `realpath` shipped
    // with the darwin-arm64 release bundle has no `-e` flag, so remote
    // servers on macOS failed every working-directory-bound task run
    // (execute/resume/follow-up/window respawn) that hit this resolver
    // (Issue #27 review finding 1). `cd -- <path> && pwd -P` is POSIX and
    // gives the same guarantees: `cd` fails (non-zero exit) when the target
    // does not exist or is not a directory, matching `-e`'s "must exist"
    // requirement, and `pwd -P` prints the physical (symlink-resolved)
    // working directory, matching `realpath`'s symlink resolution. The `--`
    // before the path stops a value starting with `-` (e.g. `-rf`) from
    // being parsed as a `cd` option.
    const result = await this.transport.exec(`cd -- ${toRemotePathExpr(targetPath)} && pwd -P`);
    // Strip only the trailing line terminator `pwd` appends, not
    // `String.trim()` — `.trim()` would also remove leading/trailing
    // whitespace that is part of a legitimate directory name, silently
    // resolving to a different (and possibly unintended) path than the one
    // that was actually verified (Issue #27 review finding). POSIX `pwd`
    // terminates its output with LF only, so only `\n` is stripped here — a
    // trailing CR is a legitimate path byte and must be preserved (stripping
    // `\r?` as well would treat `/srv/project\r` as `/srv/project` and let
    // its contents pass containment checks meant for a different directory).
    const resolved = result.stdout.replace(/\n$/, '');
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
// NOTE: `PathContainment` verifies structural containment only (target is
// `allowedRoot` itself or strictly beneath it, after symlink resolution). It
// deliberately does not restrict the character set of `target`/`allowedRoot`
// — a previous revision ran the resolved target through git's
// `assertSafePath` (`SAFE_PATH_PATTERN`) here, on the theory that downstream
// shell interpolation needed the input pre-restricted to a safe character
// set. That was the wrong layer for the fix: it rejected legitimate
// directory names (e.g. `/srv/repo+tools`) that a *quoted* shell command
// handles just fine, breaking window respawn for real repos. The correct
// invariant is "quote at every shell boundary", not "restrict characters
// globally" (Issue #27 review finding 2). Containment verification and
// character-set restriction are separate concerns; only the former belongs
// here. `IWorktreeService` (`WorktreeService.ts` / `RemoteWorktreeService.ts`)
// still calls `assertSafePath` independently — see the asymmetry note on
// `assertPathContained` below.
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
 *
 * This function does **not** restrict the character set of the resolved
 * path (see the NOTE above `isPathContained`) — downstream shell
 * interpolation is responsible for quoting the value it receives, not for
 * relying on an upstream character-set filter. `PushVerifier` quotes both
 * `workingDir` and `branch` via `shellQuote()` for exactly this reason.
 *
 * Asymmetry with `RemoteWorktreeService`: that service still calls
 * `assertSafePath` on its own paths independently of this module (see its
 * own comments) — changing that call site was out of scope here because it
 * has broader blast radius. That means a resolved path containing a
 * shell-sensitive character (allowed through by this function) can still be
 * rejected later if it reaches `RemoteWorktreeService`. The worktree path is
 * the stricter one of the two; this function's contract is containment only.
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
