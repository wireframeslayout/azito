import { describe, it, expect } from 'vitest';
import {
  applyRepositoryCandidate,
  applyRepositoryUrlChange,
  buildRepositoryCreatePayload,
  buildRepositoryRowView,
  collectDistributionRepositoryIds,
  detectRepositoryProvider,
  EMPTY_REPOSITORY_FORM,
  resolveRepositoryRegistration,
  type RepositoryCreatePayload,
  type RepositoryFormValues,
} from './repositoryForm';

/** テスト用: 成功を前提にペイロードだけ取り出す。 */
function payloadOf(values: RepositoryFormValues): RepositoryCreatePayload {
  const result = buildRepositoryCreatePayload(values);
  if (!result.ok) throw new Error(`expected a payload, got error: ${result.error}`);
  return result.payload;
}

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

describe('detectRepositoryProvider', () => {
  it('detects github from https and ssh URLs', () => {
    expect(detectRepositoryProvider('https://github.com/acme/widgets')).toBe('github');
    expect(detectRepositoryProvider('git@github.com:acme/widgets.git')).toBe('github');
  });

  it('detects gitlab including gitlab-named self-hosted hosts and nested groups', () => {
    expect(detectRepositoryProvider('https://gitlab.com/acme/widgets')).toBe('gitlab');
    expect(detectRepositoryProvider('https://gitlab.example.com/group/sub/widgets.git')).toBe('gitlab');
  });

  // 判定できないものは 'other' へ丸めず null を返す。フォームはこの null を
  // 見て手動選択欄を出す（自己ホスト型が 'other' に固定される退行の防止）。
  it('returns null — never "other" — for a host it cannot classify', () => {
    expect(detectRepositoryProvider('https://github.mycorp.com/owner/repo')).toBeNull();
    expect(detectRepositoryProvider('https://git.mycorp.com/group/repo')).toBeNull();
    expect(detectRepositoryProvider('https://bitbucket.org/acme/widgets.git')).toBeNull();
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
  it('reports url_required for a blank URL', () => {
    expect(buildRepositoryCreatePayload(EMPTY_REPOSITORY_FORM)).toEqual({ ok: false, error: 'url_required' });
    expect(buildRepositoryCreatePayload({ ...EMPTY_REPOSITORY_FORM, url: '   ' })).toEqual({ ok: false, error: 'url_required' });
  });

  // 未選択のまま 'other' に落として登録させない。
  it('reports provider_required when the URL is unrecognized and nothing was picked', () => {
    expect(buildRepositoryCreatePayload({ ...EMPTY_REPOSITORY_FORM, url: 'https://github.mycorp.com/owner/repo' }))
      .toEqual({ ok: false, error: 'provider_required' });
  });

  // GitHub Enterprise Server: ホストが github.com ではないので自動判定できない。
  // 手動選択で 'github' として登録できること（isSupportedProvider が true に
  // なり、Issue インポート等のプロバイダ機能が使える）。
  it('registers a GitHub Enterprise Server URL as github when picked manually', () => {
    const typed = applyRepositoryUrlChange(EMPTY_REPOSITORY_FORM, 'https://github.mycorp.com/owner/repo');
    const payload = payloadOf({ ...typed, provider: 'github' });
    expect(payload.provider).toBe('github');
    expect(payload.url).toBe('https://github.mycorp.com/owner/repo');
  });

  // ホスト名に 'gitlab' を含まない自己ホスト GitLab。
  it('registers a self-hosted GitLab URL without "gitlab" in the host as gitlab when picked manually', () => {
    const typed = applyRepositoryUrlChange(EMPTY_REPOSITORY_FORM, 'https://git.mycorp.com/group/repo');
    const payload = payloadOf({ ...typed, provider: 'gitlab' });
    expect(payload.provider).toBe('gitlab');
    expect(payload.url).toBe('https://git.mycorp.com/group/repo');
  });

  // 判定できる URL ではプロバイダを訊かない（手動選択は空のままでも登録でき、
  // 誤って残った手動選択より自動判定が優先される）。
  it('never asks for a provider on a recognizable URL', () => {
    const typed = applyRepositoryUrlChange(EMPTY_REPOSITORY_FORM, 'https://github.com/owner/repo');
    expect(detectRepositoryProvider(typed.url)).toBe('github');
    expect(payloadOf(typed).provider).toBe('github');
    expect(payloadOf({ ...typed, provider: 'gitlab' }).provider).toBe('github');
  });

  // 設定画面・サイドバーのどちらから開いても、モーダル経由の POST 本文が
  // 従来のインラインフォームと同一であること。
  it('produces the same body as the removed inline forms', () => {
    const typed = applyRepositoryUrlChange(EMPTY_REPOSITORY_FORM, 'https://github.com/acme/widgets.git');
    const values: RepositoryFormValues = { ...typed, displayName: ' frontend ', token: ' ghp_secret ' };

    const payload = payloadOf(values);

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
    const payload = payloadOf({ ...EMPTY_REPOSITORY_FORM, url: 'https://example.com/x.git', provider: 'other' });
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ url: 'https://example.com/x.git', provider: 'other' });
  });

  it('derives the provider from a recognizable URL without asking', () => {
    expect(payloadOf({ ...EMPTY_REPOSITORY_FORM, url: 'https://gitlab.com/acme/widgets' }).provider).toBe('gitlab');
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
