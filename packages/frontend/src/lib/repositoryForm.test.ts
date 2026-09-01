import { describe, it, expect } from 'vitest';
import {
  applyRepositoryCandidate,
  applyRepositoryUrlChange,
  buildRepositoryCreatePayload,
  buildRepositoryRowView,
  collectDistributionRepositoryIds,
  EMPTY_REPOSITORY_FORM,
  resolveRepositoryProvider,
  resolveRepositoryRegistration,
  type RepositoryFormValues,
} from './repositoryForm';

/**
 * 統合前の実装をそのまま写したもの。ProjectWizardSteps.tsx にあった
 * `parseCloneUrlForRegistration`（lib/gitProvider.ts の parseRepoUrl の
 * ローカル複製）と、ProjectSettings / RepoSidebar のインラインフォームが
 * 組み立てていた POST 本文。統合後も挙動が変わらないことを担保するための参照実装。
 */
function legacyParseCloneUrlForRegistration(url: string): { provider: 'github' | 'gitlab' | 'other'; owner: string | null; repoName: string | null } {
  const ghMatch = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (ghMatch) return { provider: 'github', owner: ghMatch[1], repoName: ghMatch[2] };
  const glMatch = url.match(/gitlab[^/]*[/:]([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/);
  if (glMatch) return { provider: 'gitlab', owner: glMatch[1], repoName: glMatch[2] };
  return { provider: 'other', owner: null, repoName: null };
}

/** インラインフォーム（ProjectSettings.tsx / RepoSidebar.tsx）が送っていた POST 本文。 */
function legacyPayload(form: { url: string; name: string; provider: string; owner: string; repoName: string; token: string }) {
  return {
    url: form.url.trim(), name: form.name.trim() || undefined, provider: form.provider,
    owner: form.owner.trim() || undefined, repo_name: form.repoName.trim() || undefined,
    token: form.token.trim() || undefined,
  };
}

const URLS = [
  'https://github.com/acme/widgets',
  'https://github.com/acme/widgets.git',
  'git@github.com:acme/widgets.git',
  'https://gitlab.com/acme/widgets',
  'https://gitlab.example.com/group/sub/widgets.git',
  'git@gitlab.com:acme/widgets.git',
  'https://bitbucket.org/acme/widgets.git',
  'https://example.com/not-a-repo',
  '',
];

describe('resolveRepositoryRegistration', () => {
  // parseCloneUrlForRegistration を parseRepoUrl へ一本化してもウィザードの
  // 挙動が変わらないこと（返り値が旧実装と完全一致すること）。
  it.each(URLS)('matches the removed parseCloneUrlForRegistration for %j', (url) => {
    expect(resolveRepositoryRegistration(url)).toEqual(legacyParseCloneUrlForRegistration(url));
  });
});

describe('resolveRepositoryProvider', () => {
  it('detects github from https and ssh URLs', () => {
    expect(resolveRepositoryProvider('https://github.com/acme/widgets')).toBe('github');
    expect(resolveRepositoryProvider('git@github.com:acme/widgets.git')).toBe('github');
  });

  it('detects gitlab including self-hosted hosts and nested groups', () => {
    expect(resolveRepositoryProvider('https://gitlab.com/acme/widgets')).toBe('gitlab');
    expect(resolveRepositoryProvider('https://gitlab.example.com/group/sub/widgets.git')).toBe('gitlab');
  });

  it('falls back to other for an unrecognized host', () => {
    expect(resolveRepositoryProvider('https://bitbucket.org/acme/widgets.git')).toBe('other');
  });
});

describe('applyRepositoryUrlChange', () => {
  it('auto-fills owner/repoName from a recognized URL', () => {
    const next = applyRepositoryUrlChange(EMPTY_REPOSITORY_FORM, 'https://github.com/acme/widgets.git');
    expect(next).toEqual({ ...EMPTY_REPOSITORY_FORM, url: 'https://github.com/acme/widgets.git', owner: 'acme', repoName: 'widgets' });
  });

  it('keeps already-entered owner/repoName when the URL cannot be parsed', () => {
    const values: RepositoryFormValues = { ...EMPTY_REPOSITORY_FORM, owner: 'acme', repoName: 'widgets' };
    expect(applyRepositoryUrlChange(values, 'https://example.com/x')).toEqual({ ...values, url: 'https://example.com/x' });
  });

  it('does not mutate the given values', () => {
    const values = { ...EMPTY_REPOSITORY_FORM };
    applyRepositoryUrlChange(values, 'https://github.com/acme/widgets');
    expect(values).toEqual(EMPTY_REPOSITORY_FORM);
  });
});

describe('applyRepositoryCandidate', () => {
  it('takes owner/repoName from the candidate', () => {
    const next = applyRepositoryCandidate(EMPTY_REPOSITORY_FORM, {
      httpsUrl: 'https://github.com/acme/widgets.git', owner: 'acme', repoName: 'widgets',
    });
    expect(next.url).toBe('https://github.com/acme/widgets.git');
    expect(next.owner).toBe('acme');
    expect(next.repoName).toBe('widgets');
  });

  it('falls back to parsing the URL when the candidate carries no owner/repoName', () => {
    const next = applyRepositoryCandidate(EMPTY_REPOSITORY_FORM, {
      httpsUrl: 'https://gitlab.com/acme/widgets.git', owner: null, repoName: null,
    });
    expect(next).toEqual({ ...EMPTY_REPOSITORY_FORM, url: 'https://gitlab.com/acme/widgets.git', owner: 'acme', repoName: 'widgets' });
  });
});

describe('buildRepositoryCreatePayload', () => {
  it('returns null for a blank URL (the caller shows the validation error)', () => {
    expect(buildRepositoryCreatePayload(EMPTY_REPOSITORY_FORM)).toBeNull();
    expect(buildRepositoryCreatePayload({ ...EMPTY_REPOSITORY_FORM, url: '   ' })).toBeNull();
  });

  // 設定画面・サイドバーのどちらから開いても、モーダル経由の POST 本文が
  // 従来のインラインフォームと同一であること。
  it('produces the same body as the removed inline forms', () => {
    const typed = applyRepositoryUrlChange(EMPTY_REPOSITORY_FORM, 'https://github.com/acme/widgets.git');
    const values: RepositoryFormValues = { ...typed, displayName: ' frontend ', token: ' ghp_secret ' };

    const payload = buildRepositoryCreatePayload(values);

    expect(payload).toEqual(legacyPayload({
      url: 'https://github.com/acme/widgets.git', name: ' frontend ', provider: 'github',
      owner: 'acme', repoName: 'widgets', token: ' ghp_secret ',
    }));
    expect(JSON.stringify(payload)).toBe(JSON.stringify({
      url: 'https://github.com/acme/widgets.git',
      name: 'frontend',
      provider: 'github',
      owner: 'acme',
      repo_name: 'widgets',
      token: 'ghp_secret',
    }));
  });

  it('omits every optional field that is left blank', () => {
    const payload = buildRepositoryCreatePayload({ ...EMPTY_REPOSITORY_FORM, url: 'https://example.com/x.git' });
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ url: 'https://example.com/x.git', provider: 'other' });
  });

  it('derives the provider from the URL now that the select is gone', () => {
    expect(buildRepositoryCreatePayload({ ...EMPTY_REPOSITORY_FORM, url: 'https://gitlab.com/acme/widgets' })?.provider).toBe('gitlab');
  });
});

describe('buildRepositoryRowView', () => {
  const repo = { url: 'https://github.com/acme/widgets.git', name: 'frontend', provider: 'github', owner: 'acme', repoName: 'widgets', hasToken: true };

  it('uses the display name as the title and owner/repoName as the description', () => {
    const view = buildRepositoryRowView(repo, { usedAsDistributionSource: false });
    expect(view.title).toBe('frontend');
    expect(view.description).toBe('acme/widgets');
  });

  it('falls back to the URL path when owner/repoName are missing', () => {
    const view = buildRepositoryRowView({ url: 'https://github.com/acme/widgets' }, { usedAsDistributionSource: false });
    expect(view.title).toBe('acme/widgets');
    expect(view.description).toBe('acme/widgets');
    expect(view.provider).toBe('github');
  });

  it('marks a token-bearing repository and one used as a distribution source', () => {
    const view = buildRepositoryRowView(repo, { usedAsDistributionSource: true });
    expect(view.chips.map((c) => c.id)).toEqual(['provider', 'token', 'distribution']);
    expect(view.chips.find((c) => c.id === 'token')?.labelKey).toBe('repo.chipTokenSet');
  });

  it('shows the missing-token chip and no distribution chip otherwise', () => {
    const view = buildRepositoryRowView({ ...repo, hasToken: false }, { usedAsDistributionSource: false });
    expect(view.chips.map((c) => c.id)).toEqual(['provider', 'token']);
    expect(view.chips.find((c) => c.id === 'token')?.labelKey).toBe('repo.chipTokenNone');
  });

  it('omits the token chip entirely when the API did not report it', () => {
    const view = buildRepositoryRowView({ url: 'https://github.com/acme/widgets' }, { usedAsDistributionSource: false });
    expect(view.chips.map((c) => c.id)).toEqual(['provider']);
  });
});

describe('collectDistributionRepositoryIds', () => {
  it('collects only the ids actually referenced by a project server', () => {
    const ids = collectDistributionRepositoryIds([
      { distributionRepositoryId: 3 },
      { distributionRepositoryId: null },
      {},
      { distributionRepositoryId: 3 },
      { distributionRepositoryId: 7 },
    ]);
    expect([...ids].sort()).toEqual([3, 7]);
  });
});
