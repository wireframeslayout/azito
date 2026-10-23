import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { invalidHostPathReason, isHostPathContained, pathApiFor } from '../../shared/os/hostPath';

/**
 * Path pair shared by the containment functions below. Bundling `target`/`allowedRoot` into a named-field object — rather
 * than two adjacent `string` parameters — keeps a caller that swaps their order from silently inverting the security judgment
 * (a legitimate path rejected, or worse, one that should be rejected allowed): with an object the swap is a visible,
 * grep-able mistake at every call site (Issue #27 review finding 4).
 */
export interface PathContainmentPair {
  target: string;
  allowedRoot: string;
}

/**
 * Containment is judged on the host that owns the paths: both sides are resolved there to their real paths (symbolic links
 * and Windows junctions followed, notation made the filesystem's own) by `IFileOps.realpath`, and compared with that host's
 * path rules (`isHostPathContained`: `relative()` of the host's path API, never a string prefix — `/a/bc` is not under
 * `/a/b` — and, on Windows, with case kept). It verifies structure only: it does not restrict the character set of a path.
 * The invariant for shell use is to quote at every shell boundary, not to filter characters up here (Issue #27 review
 * finding 2); `IWorktreeService` still calls `assertSafePath` for its own commands.
 *
 * One race remains, as it always did: an ancestor directory could be swapped for a symbolic link after the check and before
 * the caller uses the path. Closing it needs an atomic "resolve and open beneath" primitive (`openat2(RESOLVE_BENEATH)`), which
 * Node's `fs` does not have; the residual is accepted and documented rather than hidden behind a partial mitigation.
 */

function cannotVerify(label: string, reason: string): Error {
  return new Error(`Cannot verify ${label} stays within the allowed directory (${reason})`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertValidInputs(fileOps: IFileOps, inputs: string[], label: string): void {
  for (const input of inputs) {
    const reason = invalidHostPathReason(fileOps.platform, input);
    if (reason !== null) throw cannotVerify(label, `invalid path: ${reason}`);
  }
}

/**
 * Resolves both `target` and `allowedRoot` to real paths and asserts the target is `allowedRoot` itself or strictly beneath
 * it. Fail-fast: any resolution failure (a path that is missing or refused, an unreachable host...) is "not contained" — a
 * task must never run outside its configured directory just because containment could not be verified. Windows device
 * paths, drive-relative paths and alternate data streams are refused before the host is asked.
 *
 * Returns the resolved (symlink-free, absolute) target. Callers must use that value, not the original `target`, for
 * whatever follows (worktree creation, `cd`, persistence): checking one path and using another would leave a window for a
 * link swapped in between (Issue #27 review finding 2).
 */
export async function assertPathContained(fileOps: IFileOps, { target, allowedRoot }: PathContainmentPair, label: string): Promise<string> {
  assertValidInputs(fileOps, [target, allowedRoot], label);
  let resolvedTarget: string;
  let resolvedRoot: string;
  try {
    [resolvedTarget, resolvedRoot] = await Promise.all([fileOps.realpath(target), fileOps.realpath(allowedRoot)]);
  } catch (err) {
    throw cannotVerify(label, describe(err));
  }
  if (!isHostPathContained(fileOps.platform, { target: resolvedTarget, allowedRoot: resolvedRoot })) {
    throw new Error(`${label} escapes the allowed directory`);
  }
  return resolvedTarget;
}

/**
 * Same verdict for a path that may not exist yet (the destination of a create, a rename or a first write): the nearest
 * existing ancestor is resolved on the host and the missing remainder is put back on it, so a link on the way out of the root
 * is caught although the path itself cannot be resolved. Returns the resolved path (ancestor's real path + the remainder).
 */
export async function assertNewPathContained(fileOps: IFileOps, { target, allowedRoot }: PathContainmentPair, label: string): Promise<string> {
  assertValidInputs(fileOps, [target, allowedRoot], label);
  const api = pathApiFor(fileOps.platform);
  const missing: string[] = [];
  let resolvedTarget: string;
  let resolvedRoot: string;
  try {
    let ancestor = target;
    for (;;) {
      try {
        resolvedTarget = api.join(await fileOps.realpath(ancestor), ...missing);
        break;
      } catch (err) {
        const parent = api.dirname(ancestor);
        // Only "this part does not exist yet" is walked past; any other failure (a permission, a file where a directory
        // should be, an unreachable host) leaves the path unverified.
        if (!(err instanceof FileOpsError) || err.code !== 'NOT_FOUND' || parent === ancestor) throw err;
        missing.unshift(api.basename(ancestor));
        ancestor = parent;
      }
    }
    resolvedRoot = await fileOps.realpath(allowedRoot);
  } catch (err) {
    throw cannotVerify(label, describe(err));
  }
  if (!isHostPathContained(fileOps.platform, { target: resolvedTarget, allowedRoot: resolvedRoot })) {
    throw new Error(`${label} escapes the allowed directory`);
  }
  return resolvedTarget;
}

/**
 * Shared choke point for "verify containment, then use the resolved path" — the piece every launch/resume/respawn path needs
 * (Issue #27 review finding 1): `ExecuteTaskUseCase`, `TaskRestoreService` and `WindowRespawnService` all run it, and so do the
 * file APIs. Skips (returns `target` unchanged, nothing resolved) when `allowedRoot` is unset: no configured boundary to enforce.
 */
export async function assertDirectoryContained(
  fileOps: IFileOps,
  { target, allowedRoot }: { target: string; allowedRoot: string | null | undefined },
  label: string,
): Promise<string> {
  if (!allowedRoot) return target;
  return assertPathContained(fileOps, { target, allowedRoot }, label);
}
