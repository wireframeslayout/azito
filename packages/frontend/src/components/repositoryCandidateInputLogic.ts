// Pure helper logic for RepositoryCandidateInput, split out so it can be
// unit tested directly — same convention as DirectoryInput's dropdown
// behavior and repoDiscoveryDialogLogic.ts (this codebase has no
// component-test infrastructure; pure logic is tested instead, see
// projectWizardLogic.ts / distributeCodePolicy.ts).

export type RepositoryCandidateProvider = 'github' | 'gitlab' | 'other';

/** Frontend mirror of the server's `RepositoryCandidate` (RepositoryCandidateService.ts). */
export interface RepositoryCandidate {
  source: 'registered' | 'provider';
  provider: RepositoryCandidateProvider;
  owner: string | null;
  repoName: string | null;
  httpsUrl: string;
  defaultBranch: string | null;
  private: boolean | null;
  updatedAt: string | null;
  hasToken: boolean;
}

export interface ProviderFetchError {
  provider: 'github' | 'gitlab';
  message: string;
}

export interface RepositoryCandidatesResult {
  candidates: RepositoryCandidate[];
  truncated: boolean;
  providerErrors: ProviderFetchError[];
}

/** A group key: 'registered' for already-registered repositories (shown first, regardless of their provider), otherwise the provider name. */
export type RepositoryCandidateGroupKey = 'registered' | RepositoryCandidateProvider;

export interface RepositoryCandidateGroup {
  groupKey: RepositoryCandidateGroupKey;
  candidates: RepositoryCandidate[];
}

/**
 * Groups candidates by `source` — 'registered' candidates form a single
 * group (regardless of their own `provider`, since they may originate
 * from any provider or none) shown FIRST, because a registered repository
 * may already carry a reusable token (see `hasToken`). Remaining
 * (`source: 'provider'`) candidates are grouped by `provider`, ordered
 * alphabetically after the registered group, so the grouping/ordering is
 * deterministic regardless of the server response's own ordering.
 */
export function groupRepositoryCandidates(candidates: RepositoryCandidate[]): RepositoryCandidateGroup[] {
  const groups = new Map<RepositoryCandidateGroupKey, RepositoryCandidate[]>();
  for (const candidate of candidates) {
    const key: RepositoryCandidateGroupKey = candidate.source === 'registered' ? 'registered' : candidate.provider;
    const existing = groups.get(key);
    if (existing) existing.push(candidate);
    else groups.set(key, [candidate]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'registered') return -1;
    if (b === 'registered') return 1;
    return a.localeCompare(b);
  });
  return keys.map((groupKey) => ({ groupKey, candidates: groups.get(groupKey)! }));
}

/**
 * Decides the clone-branch field's value after the operator picks a
 * candidate. Never overwrites a branch the operator has already typed by
 * hand (`userTouchedBranch`) — only an untouched field (still at its
 * wizard default) may be auto-filled from the candidate's
 * `defaultBranch`. A candidate with no known default branch (`null`/empty,
 * e.g. an 'existing'-mode discovery has no such field, or the provider
 * didn't report one) leaves the current value alone.
 */
export function resolveBranchOnCandidateSelect(
  userTouchedBranch: boolean,
  candidateDefaultBranch: string | null,
  currentBranch: string,
): string {
  if (userTouchedBranch) return currentBranch;
  if (!candidateDefaultBranch || !candidateDefaultBranch.trim()) return currentBranch;
  return candidateDefaultBranch;
}

/**
 * Applies a request guard (see `createRequestGuard` in
 * repoDiscoveryDialogLogic.ts, reused here rather than duplicated) around
 * an async candidate fetch: resolves to the fetched result only if no
 * later request has started in the meantime, otherwise resolves to `null`
 * so the caller can skip applying a stale response. Mirrors
 * `DirectoryInput`'s ordering guarantee for its own suggestion fetches.
 */
/**
 * Advances the request guard synchronously on every edit (not after the
 * debounce delay) and returns the state an editing input must apply
 * immediately: the new request's id (threaded through to the delayed
 * fetch, see `fetchCandidatesGuarded`) plus a cleared/closed dropdown.
 *
 * Review finding: the previous implementation only advanced the guard
 * inside the debounced fetch itself, so a query's stale candidate list
 * stayed open and selectable for the whole 300ms debounce window after
 * the operator kept typing — pressing Enter in that window replaced the
 * just-typed URL with a stale candidate. Calling `guard.start()` here,
 * synchronously from `handleChange`, invalidates the previous request id
 * immediately (verified without waiting for any timer/promise) and clears
 * the stale candidates before the debounce timer is even set.
 *
 * Review finding (round 2): clearing `result` must not also force the
 * dropdown closed unconditionally — doing so made the "fetching" state
 * (rendered from `loading`) unreachable, since the dropdown itself was
 * gone until the response landed. When the input still has focus, `open`
 * stays true so the loading indicator can render in an otherwise-empty
 * dropdown; the stale *candidates* are still gone (`result: null`), so
 * nothing selectable survives the edit.
 */
export function beginCandidateEditRequest(
  guard: { start(): number },
  hasFocus: boolean,
): { requestId: number; result: null; open: boolean } {
  return { requestId: guard.start(), result: null, open: hasFocus };
}

export async function fetchCandidatesGuarded(
  query: string,
  requestId: number,
  guard: { isCurrent(id: number): boolean },
  fetchFn: (query: string) => Promise<RepositoryCandidatesResult>,
): Promise<RepositoryCandidatesResult | null> {
  const result = await fetchFn(query);
  return guard.isCurrent(requestId) ? result : null;
}
