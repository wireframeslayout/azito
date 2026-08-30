import { describe, it, expect } from 'vitest';
import { createRequestGuard } from './repoDiscoveryDialogLogic';
import {
  groupRepositoryCandidates, resolveBranchOnCandidateSelect, fetchCandidatesGuarded,
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
