import type { HostPlatform } from '../../shared/os/hostEnv';
import { invalidWorkingDirectoryReason } from '../../shared/os/hostPath';

export const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9_./-]+$/;

// Fully-qualified refs (e.g. `refs/heads/main`) are allowed by SAFE_BRANCH_PATTERN
// (slashes are a normal, legitimate part of a branch name like `feature/x`), but
// letting one through as a "branch name" is dangerous: `git worktree add <path>
// refs/heads/main` resolves directly to whatever the local `main` ref happens to
// point at right now — bypassing any baseBranch/tracking-ref resolution the
// caller intended — and it also lets `refs/heads/<name> === baseBranch`-style
// string comparisons be evaded by a value that is semantically the same branch
// (Issue #87 third-party review, 9th round, Important finding 1).
export function isFullyQualifiedRef(value: string): boolean {
  return value.startsWith('refs/');
}

/**
 * A value passed to git as a positional argument must not be read as an option. A command run without a shell cannot be
 * split into extra arguments, but `-x` is still an option to git itself: the safe-pattern checks above allow a leading `-`.
 */
export function assertNotOptionLike(value: string, label: string): void {
  if (value.startsWith('-')) throw new Error(`Unsafe ${label}: ${value}`);
}

/**
 * A host path handed to git as an argument. git runs as a CommandSpec (an argv, never a shell line), so the characters of the
 * path cannot split the command or be interpreted: spaces, Japanese and a Windows `\` are all fine. What is left to refuse is a path git would
 * not take as a path: one the host cannot use at all (empty, NUL, a Windows device path / drive-relative / stream), a relative one (resolved against an unknown directory), and
 * one that git would read as an option (`assertNotOptionLike`).
 *
 * `~` is accepted but git does not expand it: `runGit` / `resolveGitPath` resolve it against the host's home directory first.
 * This holds for a path passed in an argv; a path that is spliced into a shell line (`GitInfoCollector.collectGitInfoRemote`,
 * `execWithSentinel`) is POSIX-only and quoted with `shellQuote`.
 */
export function assertGitPathArg(platform: HostPlatform, value: string, label: string): void {
  assertNotOptionLike(value, label);
  const reason = invalidWorkingDirectoryReason(platform, value);
  if (reason) throw new Error(`Unsafe ${label}: ${reason}`);
}

/**
 * Why a new working directory / worktree path (a project server's, a task's) is refused at the API boundary, or null.
 * `platform` null is a server that is not known yet (an agent that has not reported its OS, a task whose server is chosen
 * later from its unit or project): the path is then accepted when it is valid on at least one OS, and the host-specific
 * check is made later where the host is known.
 */
export function invalidStoredWorkingDirectoryReason(platform: HostPlatform | null, value: string): string | null {
  if (platform) return invalidWorkingDirectoryReason(platform, value);
  const posix = invalidWorkingDirectoryReason('linux', value);
  if (posix === null) return null;
  return invalidWorkingDirectoryReason('win32', value) === null ? null : posix;
}

// Shell-safety validation ONLY. This function is called against values that
// are already persisted (task.branch, baseBranch resolved from a stored
// task/project row, ...), not just against fresh API input — Local/Remote
// WorktreeService and RemoteBundleOps call it with whatever a pre-existing
// task already has saved. It used to also reject fully-qualified refs
// (`refs/...`), but that rejection ran against those SAME persisted values:
// a task saved before `rejectQualifiedBranchInput` existed at the API
// boundary (see below) could have `branch: 'refs/heads/main'` sitting in the
// database already, and every attempt to run it would throw here, forever
// (Issue #87 third-party review, 12th round, Important finding 2 — this
// broke backward compatibility for exactly the tasks the API-boundary check
// was designed not to touch). Rejecting a fully-qualified ref belongs ONLY
// at the API boundary for NEW input (`rejectQualifiedBranchInput`); a
// value that already reached this function is normalized at resolve time
// instead (`canonicalizeBaseBranch` / `normalizeBranchRef`), never rejected.
export function assertSafeBranch(value: string, label: string): void {
  if (!SAFE_BRANCH_PATTERN.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
}

/**
 * API-boundary validation for a NEW branch-name input: `null` when `value`
 * is safe to store as a plain branch name, otherwise a human-readable reason
 * suitable for a 400 response. Rejects the same two qualifiers
 * `TaskExecutionEnv.canonicalizeBaseBranch` normalizes away downstream —
 * fully-qualified refs (`refs/...`) and remote-qualified names
 * (`origin/...`) — so a value this rejects can never reach the
 * unnormalized-branch failure mode `canonicalizeBaseBranch` exists to fix.
 * Shared by every route that persists a new branch-shaped field (task
 * base_branch/branch/target_branch, project default_branch, project_server
 * branch — Issue #87 third-party review, 11th round, Important finding 1)
 * so the same rule can't drift between them. This is an input-boundary
 * check only — callers must not run it against already-stored values (a
 * value saved before this check existed must keep working; normalization at
 * resolve time, not rejection, handles that case).
 */
export function rejectQualifiedBranchInput(value: string): string | null {
  if (!SAFE_BRANCH_PATTERN.test(value)) return 'invalid branch name';
  if (isFullyQualifiedRef(value)) return 'fully-qualified ref names (refs/...) are not allowed, specify a plain branch name';
  if (value.startsWith('origin/')) return 'remote-qualified branch names (origin/...) are not allowed, specify a plain branch name';
  return null;
}

// Strips a `refs/heads/` prefix so full-ref and plain-name spellings of the
// same branch compare equal. Used as a defense-in-depth normalization layer
// wherever a branch name is compared for equality — API-boundary validation
// (assertSafeBranch above) rejects new fully-qualified refs, but this keeps
// the comparison itself safe against any value that reaches it unvalidated
// (pre-existing data, other code paths) (Issue #87 third-party review, 9th
// round, Important finding 1).
export function normalizeBranchRef(value: string): string {
  return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
}
