export type GitProvider = 'github' | 'gitlab';

const GITHUB_URL_RE = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
const GITLAB_URL_RE = /gitlab[^/]*[/:]([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+?)(?:\.git)?$/;

/** URLからprovider/owner/repoを推定。判定不能ならnull */
export function parseRepoUrl(url: string): { provider: GitProvider; owner: string; repo: string } | null {
  const ghMatch = url.match(GITHUB_URL_RE);
  if (ghMatch) return { provider: 'github', owner: ghMatch[1], repo: ghMatch[2] };

  const glMatch = url.match(GITLAB_URL_RE);
  if (glMatch) return { provider: 'gitlab', owner: glMatch[1], repo: glMatch[2] };

  return null;
}

/** providerとして対応済みか（issue import等の機能が使えるか） */
export function isSupportedProvider(provider: string | null | undefined): provider is GitProvider {
  return provider === 'github' || provider === 'gitlab';
}

/** repoUrlからスキーム+ホスト部分（origin）を抽出。HTTPS/SSH(scp-like)いずれも対応。判定不能ならnull */
function originFromRepoUrl(repoUrl: string): string | null {
  const httpMatch = repoUrl.match(/^(https?:\/\/[^/]+)/);
  if (httpMatch) return httpMatch[1];

  const sshMatch = repoUrl.match(/^(?:[\w-]+@)?([^:/]+)[:/]/);
  if (sshMatch) return `https://${sshMatch[1]}`;

  return null;
}

function resolveOrigin(provider: GitProvider, repoUrl?: string | null): string {
  if (repoUrl) {
    const origin = originFromRepoUrl(repoUrl);
    if (origin) return origin;
  }
  return provider === 'gitlab' ? 'https://gitlab.com' : 'https://github.com';
}

/**
 * Issue のweb URLを構築。repoUrl があればそれを origin として使い（self-hosted対応）、
 * 無ければ github.com / gitlab.com にフォールバック
 */
export function buildIssueUrl(
  provider: GitProvider,
  owner: string,
  repo: string,
  issueNumber: number,
  repoUrl?: string | null,
): string {
  const origin = resolveOrigin(provider, repoUrl);
  return provider === 'gitlab'
    ? `${origin}/${owner}/${repo}/-/issues/${issueNumber}`
    : `${origin}/${owner}/${repo}/issues/${issueNumber}`;
}

/** リポジトリ表示名（URLからホストprefixを除いた owner/repo 形式） */
export function repoDisplayName(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?[^/]+\//, '').replace(/\.git$/, '');
}
