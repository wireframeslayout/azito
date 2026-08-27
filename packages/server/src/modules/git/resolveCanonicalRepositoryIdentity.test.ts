import { describe, it, expect } from 'vitest';
import { resolveCanonicalRepositoryIdentity } from './resolveCanonicalRepositoryIdentity';

describe('resolveCanonicalRepositoryIdentity', () => {
  it('resolves ok when url and owner/repoName agree', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'https://github.com/wireframeslayout/azito.git',
      provider: 'github',
      owner: 'wireframeslayout',
      repoName: 'azito',
    });

    expect(result).toEqual({
      ok: true,
      identity: {
        provider: 'github',
        host: 'github.com',
        owner: 'wireframeslayout',
        repo: 'azito',
        httpsUrl: 'https://github.com/wireframeslayout/azito.git',
      },
    });
  });

  it('normalizes an scp-like url and still agrees with matching owner/repoName', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'git@github.com:wireframeslayout/azito.git',
      provider: 'github',
      owner: 'wireframeslayout',
      repoName: 'azito',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.httpsUrl).toBe('https://github.com/wireframeslayout/azito.git');
  });

  it('agrees case-insensitively (GitHub owner casing is not always meaningful)', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'https://github.com/WireframesLayout/Azito.git',
      provider: 'github',
      owner: 'wireframeslayout',
      repoName: 'azito',
    });

    expect(result.ok).toBe(true);
  });

  // Issue #29 Step 3b review, Important finding 1: the actual attack/
  // misconfiguration this function exists to catch — a repository row whose
  // `url` names ONE repository while `owner`/`repoName` name a DIFFERENT
  // one. Every prior call site trusted one side of this without ever
  // cross-checking the other.
  it('rejects as identity_mismatch when the url names a different owner than owner/repoName', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'https://github.com/attacker-controlled/other-repo.git',
      provider: 'github',
      owner: 'wireframeslayout',
      repoName: 'azito',
    });

    expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
  });

  it('rejects as identity_mismatch when the url names a different repo than owner/repoName', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'https://github.com/wireframeslayout/other-repo.git',
      provider: 'github',
      owner: 'wireframeslayout',
      repoName: 'azito',
    });

    expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
  });

  it('rejects as url_not_normalizable when url cannot be parsed at all, regardless of owner/repoName', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'not a url at all',
      provider: 'github',
      owner: null,
      repoName: null,
    });

    expect(result).toEqual({ ok: false, reason: 'url_not_normalizable' });
  });

  it('resolves ok from the url alone when owner/repoName are both absent (unchanged behavior for a URL-only row)', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'https://github.com/wireframeslayout/azito.git',
      provider: 'github',
      owner: null,
      repoName: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.owner).toBe('wireframeslayout');
      expect(result.identity.repo).toBe('azito');
    }
  });

  // Issue #29 Step 3b re-review, Important finding 2: GitLab subgroups are
  // arbitrary-depth (`group/subgroup/repo`, or deeper). Fixing owner to
  // `segments[0]` and repo to `segments[1]` mis-splits this as
  // owner=`group`, repo=`subgroup` — silently dropping the real repo name
  // and either rejecting a correctly-registered row as `identity_mismatch`
  // or resolving to the wrong repo entirely.
  describe('GitLab subgroups', () => {
    it('resolves an https:// subgroup url with the full namespace as owner and the last segment as repo', () => {
      const result = resolveCanonicalRepositoryIdentity({
        url: 'https://gitlab.com/group/subgroup/repo.git',
        provider: 'gitlab',
        owner: null,
        repoName: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('group/subgroup');
        expect(result.identity.repo).toBe('repo');
        expect(result.identity.httpsUrl).toBe('https://gitlab.com/group/subgroup/repo.git');
      }
    });

    it('resolves an ssh:// subgroup url the same way', () => {
      const result = resolveCanonicalRepositoryIdentity({
        url: 'ssh://git@gitlab.com/group/subgroup/repo.git',
        provider: 'gitlab',
        owner: null,
        repoName: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('group/subgroup');
        expect(result.identity.repo).toBe('repo');
      }
    });

    it('resolves a scp-like subgroup url the same way', () => {
      const result = resolveCanonicalRepositoryIdentity({
        url: 'git@gitlab.com:group/subgroup/repo.git',
        provider: 'gitlab',
        owner: null,
        repoName: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('group/subgroup');
        expect(result.identity.repo).toBe('repo');
      }
    });

    it('handles a deeper (3-level) subgroup', () => {
      const result = resolveCanonicalRepositoryIdentity({
        url: 'https://gitlab.com/group/subgroup/subsubgroup/repo.git',
        provider: 'gitlab',
        owner: null,
        repoName: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.owner).toBe('group/subgroup/subsubgroup');
        expect(result.identity.repo).toBe('repo');
      }
    });

    it('still agrees when the registered owner/repoName match the full subgroup path', () => {
      const result = resolveCanonicalRepositoryIdentity({
        url: 'https://gitlab.com/group/subgroup/repo.git',
        provider: 'gitlab',
        owner: 'group/subgroup',
        repoName: 'repo',
      });

      expect(result.ok).toBe(true);
    });

    it('rejects as identity_mismatch when the registered owner omits the subgroup path', () => {
      const result = resolveCanonicalRepositoryIdentity({
        url: 'https://gitlab.com/group/subgroup/repo.git',
        provider: 'gitlab',
        owner: 'group',
        repoName: 'repo',
      });

      expect(result).toEqual({ ok: false, reason: 'identity_mismatch' });
    });

    it('no top-level GitLab project (single segment) fails closed as url_not_normalizable', () => {
      // normalizeRepositoryUrlToHttps itself already requires >=2 segments,
      // so this is covered end-to-end, not just by this function's own gate.
      const result = resolveCanonicalRepositoryIdentity({
        url: 'https://gitlab.com/onlyonesegment.git',
        provider: 'gitlab',
        owner: null,
        repoName: null,
      });

      expect(result).toEqual({ ok: false, reason: 'url_not_normalizable' });
    });
  });

  // GitHub has no subgroup concept — a URL with more than exactly 2 path
  // segments must fail closed rather than silently keep only the first two
  // and drop the rest (which would previously happen for a stray extra path
  // component, e.g. a GitHub URL fetched from a page with a `/tree/branch`
  // suffix incorrectly registered as the repository url).
  it('rejects a GitHub url with more than 2 path segments as url_not_normalizable', () => {
    const result = resolveCanonicalRepositoryIdentity({
      url: 'https://github.com/wireframeslayout/azito/tree/main',
      provider: 'github',
      owner: null,
      repoName: null,
    });

    expect(result).toEqual({ ok: false, reason: 'url_not_normalizable' });
  });
});
