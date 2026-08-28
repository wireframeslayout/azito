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
