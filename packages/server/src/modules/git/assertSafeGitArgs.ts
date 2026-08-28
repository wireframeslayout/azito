export const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_./@:~-][a-zA-Z0-9_./@:~-]*$/;
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

export function assertSafePath(value: string, label: string): void {
  if (!SAFE_PATH_PATTERN.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
}

export function assertSafeBranch(value: string, label: string): void {
  if (!SAFE_BRANCH_PATTERN.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
  if (isFullyQualifiedRef(value)) {
    throw new Error(`${label} must not be a fully-qualified ref (refs/...); specify a plain branch name instead: ${value}`);
  }
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
