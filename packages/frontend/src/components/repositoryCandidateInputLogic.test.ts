import { describe, it, expect } from 'vitest';
import { createRequestGuard } from './repoDiscoveryDialogLogic';
import {
  groupRepositoryCandidates, resolveBranchOnCandidateSelect, fetchCandidatesGuarded, beginCandidateEditRequest,
  type RepositoryCandidate, type RepositoryCandidatesResult,
} from './repositoryCandidateInputLogic';

function candidate(overrides: Partial<RepositoryCandidate>): RepositoryCandidate {
  return {
    source: 'provider',
    provider: 'github',
    owner: 'wireframeslayout',
    repoName: 'azito',
    httpsUrl: 'https://github.com/wireframeslayout/azito',
    defaultBranch: 'main',
    private: false,
    updatedAt: null,
    hasToken: false,
    ...overrides,
  };
}

describe('groupRepositoryCandidates', () => {
  it('puts the registered group first regardless of input order', () => {
    const github = candidate({ source: 'provider', provider: 'github', repoName: 'a' });
    const registered = candidate({ source: 'registered', provider: 'gitlab', repoName: 'b', hasToken: true });
    const groups = groupRepositoryCandidates([github, registered]);

    expect(groups.map((g) => g.groupKey)).toEqual(['registered', 'github']);
    expect(groups[0].candidates).toEqual([registered]);
    expect(groups[1].candidates).toEqual([github]);
  });

  it('groups provider-sourced candidates by provider, alphabetically after registered', () => {
    const gitlab = candidate({ source: 'provider', provider: 'gitlab', repoName: 'gl-repo' });
    const github = candidate({ source: 'provider', provider: 'github', repoName: 'gh-repo' });
    const other = candidate({ source: 'provider', provider: 'other', repoName: 'other-repo' });

    const groups = groupRepositoryCandidates([gitlab, github, other]);
    expect(groups.map((g) => g.groupKey)).toEqual(['github', 'gitlab', 'other']);
  });

  it('keeps a registered candidate in the registered group even when its own provider is github', () => {
    const registeredGithub = candidate({ source: 'registered', provider: 'github', hasToken: true });
    const providerGithub = candidate({ source: 'provider', provider: 'github', repoName: 'other' });

    const groups = groupRepositoryCandidates([providerGithub, registeredGithub]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ groupKey: 'registered', candidates: [registeredGithub] });
    expect(groups[1]).toEqual({ groupKey: 'github', candidates: [providerGithub] });
  });

  it('returns no groups for an empty candidate list', () => {
    expect(groupRepositoryCandidates([])).toEqual([]);
  });
});

describe('resolveBranchOnCandidateSelect', () => {
  it('fills the branch from the candidate when the field is still untouched', () => {
    expect(resolveBranchOnCandidateSelect(false, 'develop', 'main')).toBe('develop');
  });

  it('never overwrites a branch the operator already edited by hand', () => {
    expect(resolveBranchOnCandidateSelect(true, 'develop', 'my-custom-branch')).toBe('my-custom-branch');
  });

  it('leaves the current value alone when the candidate has no known default branch', () => {
    expect(resolveBranchOnCandidateSelect(false, null, 'main')).toBe('main');
    expect(resolveBranchOnCandidateSelect(false, '', 'main')).toBe('main');
    expect(resolveBranchOnCandidateSelect(false, '   ', 'main')).toBe('main');
  });
});

describe('fetchCandidatesGuarded', () => {
  function emptyResult(): RepositoryCandidatesResult {
    return { candidates: [], truncated: false, providerErrors: [] };
  }

  it('resolves the response when it is still the most recent request', async () => {
    const guard = createRequestGuard();
    const requestId = guard.start();
    const result = await fetchCandidatesGuarded('azito', requestId, guard, async () => emptyResult());
    expect(result).toEqual(emptyResult());
  });

  it('discards a stale response overtaken by a later request before it resolved', async () => {
    // Simulates: request A ("az") starts, then request B ("azito") starts
    // before A's response arrives — A must never be applied once it does,
    // even though it resolves after B started (same ordering guarantee as
    // DirectoryInput's own suggestion fetches / repoDiscoveryDialogLogic).
    const guard = createRequestGuard();
    const requestA = guard.start();
    const requestB = guard.start();

    const resultB = await fetchCandidatesGuarded('azito', requestB, guard, async () => ({ ...emptyResult(), truncated: true }));
    expect(resultB).not.toBeNull();

    const resultA = await fetchCandidatesGuarded('az', requestA, guard, async () => emptyResult());
    expect(resultA).toBeNull();
  });
});

describe('beginCandidateEditRequest', () => {
  it('invalidates the previous request synchronously, before its debounced fetch would ever fire', () => {
    // Simulates: the operator types "az" (request A starts, still
    // debouncing — no fetch in flight yet), then edits again to "azi"
    // before the 300ms debounce for A elapses. The guard must already
    // treat A as stale the instant B starts, not only once B's own fetch
    // eventually resolves — otherwise the dropdown from A's *previous*
    // completed query stays open/selectable for the whole debounce
    // window and a stray Enter can select it.
    const guard = createRequestGuard();
    const requestA = guard.start(); // query "az" begins debouncing

    const edit = beginCandidateEditRequest(guard, true); // query "azi" typed before A's debounce fires
    expect(guard.isCurrent(requestA)).toBe(false);
    expect(guard.isCurrent(edit.requestId)).toBe(true);
  });

  it('clears the stale candidate list so nothing from a superseded query can be selected mid-debounce', () => {
    const guard = createRequestGuard();
    const edit = beginCandidateEditRequest(guard, true);
    expect(edit.result).toBeNull();
  });

  it('closes the dropdown when the input is not focused', () => {
    const guard = createRequestGuard();
    const edit = beginCandidateEditRequest(guard, false);
    expect(edit.open).toBe(false);
  });

  it('keeps the dropdown open while the input has focus, so the loading indicator stays reachable', () => {
    // Review finding: clearing stale candidates on every keystroke had
    // also been forcing `open` to false unconditionally, which meant the
    // "fetching" state (rendered from `loading`) could never be shown —
    // the dropdown itself was gone until the response landed. With focus
    // still on the input, the dropdown must stay open (with no stale
    // candidates in it) so the loading indicator is reachable while a
    // slow provider request is in flight.
    const guard = createRequestGuard();
    const edit = beginCandidateEditRequest(guard, true);
    expect(edit.open).toBe(true);
    expect(edit.result).toBeNull(); // old candidates are still gone — nothing stale is selectable
  });

  it('raises loading at edit time, so an open dropdown is never empty during the debounce window', () => {
    // Review finding (round 3): opening the dropdown on edit while
    // `loading` stayed false until the 300ms debounce fired left a window
    // in which `result` was null and no content branch rendered — an
    // empty dropdown on first focus and after every keystroke. `open` and
    // `loading` must be raised together.
    const guard = createRequestGuard();
    const edit = beginCandidateEditRequest(guard, true);
    expect(edit.loading).toBe(true);
    expect(edit.open && edit.loading).toBe(true); // open implies renderable content
  });

  it('does not leave loading raised behind a closed dropdown when the input is unfocused', () => {
    const guard = createRequestGuard();
    const edit = beginCandidateEditRequest(guard, false);
    expect(edit.open).toBe(false);
  });

  it('each edit keeps invalidating the prior one, so only the very latest edit can ever adopt a response', () => {
    const guard = createRequestGuard();
    const first = beginCandidateEditRequest(guard, true);
    const second = beginCandidateEditRequest(guard, true);
    const third = beginCandidateEditRequest(guard, true);

    expect(guard.isCurrent(first.requestId)).toBe(false);
    expect(guard.isCurrent(second.requestId)).toBe(false);
    expect(guard.isCurrent(third.requestId)).toBe(true);
  });
});
