import { execSync } from 'child_process';
import type {
  RemoteIssue, ListIssuesOptions, ListIssuesResult,
  RemotePullRequest, ListPullRequestsOptions, ListPullRequestsResult,
  IGitProviderClient, RepoRef, CreatePullRequestParams,
} from './types';

export type { RemoteIssue, ListIssuesOptions, ListIssuesResult };

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL = 5 * 60 * 1000;
const LIST_CACHE_TTL = 60 * 1000;

export class GitHubClient implements IGitProviderClient {
  private cache = new Map<string, CacheEntry<unknown>>();
  private ghTokens = new Map<string, string | null>();

  /** Per-host `gh` CLI token fallback: GHE hosts need `--hostname` (mirrors GitLabClient.getGlabToken). */
  private getGhToken(host: string): string | null {
    if (this.ghTokens.has(host)) return this.ghTokens.get(host)!;
    const command = host === 'github.com' ? 'gh auth token' : `gh auth token --hostname ${host}`;
    try {
      const token = execSync(command, { encoding: 'utf-8', timeout: 5000 }).trim();
      this.ghTokens.set(host, token || null);
      return token || null;
    } catch {
      this.ghTokens.set(host, null);
      return null;
    }
  }

  private resolveToken(repoToken: string | null, host: string): string | null {
    return repoToken || this.getGhToken(host);
  }

  /**
   * API endpoint + auth host for a repo. GitHub Enterprise (self-hosted):
   * `<origin>/api/v3` with the instance's own host; github.com (or no/invalid
   * URL): `api.github.com` with auth host `github.com` (the `gh` CLI stores
   * tokens under the web host, not the API host).
   */
  private getEndpoint(repoUrl: string | null): { baseUrl: string; host: string } {
    const dotCom = { baseUrl: 'https://api.github.com', host: 'github.com' };
    if (!repoUrl) return dotCom;
    try {
      const url = new URL(repoUrl);
      if (url.host === 'github.com') return dotCom;
      return { baseUrl: `${url.protocol}//${url.host}/api/v3`, host: url.host };
    } catch {
      return dotCom;
    }
  }

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCache<T>(key: string, data: T, ttl: number = CACHE_TTL): void {
    this.cache.set(key, { data, expiresAt: Date.now() + ttl });
  }

  /** Invalidates cached pulls listings/lookups for a repo after a mutation (createPullRequest). */
  private invalidatePullsCache(baseUrl: string, owner: string, repo: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`gh:pulls:${baseUrl}:${owner}/${repo}`) || key.startsWith(`gh:pr:${baseUrl}:${owner}/${repo}`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Invalidates all cached issue listing pages for a repo (used when opts.fresh, so a later Load more never reads a stale page). */
  private invalidateIssueListCache(baseUrl: string, owner: string, repo: string): void {
    const prefix = `gh:list:${baseUrl}:${owner}/${repo}`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Invalidates all cached pull request listing pages for a repo (used when opts.fresh, so a later Load more never reads a stale page). */
  private invalidatePullListCache(baseUrl: string, owner: string, repo: string): void {
    const prefix = `gh:pulls:${baseUrl}:${owner}/${repo}`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private async request<T>(baseUrl: string, path: string, token: string | null, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private toRemoteIssue(raw: any): RemoteIssue {
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? null,
      state: raw.state,
      labels: (raw.labels || []).map((l: any) => ({
        name: typeof l === 'string' ? l : l.name,
        color: typeof l === 'string' ? '' : (l.color || ''),
      })),
      user: {
        login: raw.user?.login || '',
        avatarUrl: raw.user?.avatar_url || '',
      },
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      htmlUrl: raw.html_url,
    };
  }

  async listIssues(ref: RepoRef, opts: ListIssuesOptions = {}): Promise<ListIssuesResult> {
    const { owner, repoName: repo } = ref;
    const { baseUrl, host } = this.getEndpoint(ref.url);
    const state = opts.state || 'open';
    const page = opts.page || 1;
    const perPage = opts.perPage || 20;
    const labels = opts.labels || '';

    const params = new URLSearchParams({
      state, page: String(page), per_page: String(perPage), sort: 'updated', direction: 'desc',
    });
    if (labels) params.set('labels', labels);

    const cacheKey = `gh:list:${baseUrl}:${owner}/${repo}?${params.toString()}`;
    if (opts.fresh) {
      this.invalidateIssueListCache(baseUrl, owner, repo);
    } else {
      const cached = this.getCached<ListIssuesResult>(cacheKey);
      if (cached) return cached;
    }

    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any[]>(baseUrl, `/repos/${owner}/${repo}/issues?${params.toString()}`, resolvedToken);
    const issues = raw.filter((i: any) => !i.pull_request).map((i) => this.toRemoteIssue(i));
    const result: ListIssuesResult = { issues, page, hasMore: issues.length === perPage };

    this.setCache(cacheKey, result, LIST_CACHE_TTL);
    return result;
  }

  async searchIssues(ref: RepoRef, query: string): Promise<RemoteIssue[]> {
    const { owner, repoName: repo } = ref;
    const { baseUrl, host } = this.getEndpoint(ref.url);

    const cacheKey = `gh:search:${baseUrl}:${owner}/${repo}:${query}`;
    const cached = this.getCached<RemoteIssue[]>(cacheKey);
    if (cached) return cached;

    const resolvedToken = this.resolveToken(ref.token, host);
    const q = encodeURIComponent(`${query} repo:${owner}/${repo} is:issue`);
    const raw = await this.request<{ items: any[] }>(baseUrl, `/search/issues?q=${q}&per_page=30`, resolvedToken);
    const issues = raw.items.map((i) => this.toRemoteIssue(i));

    this.setCache(cacheKey, issues);
    return issues;
  }

  async getIssue(ref: RepoRef, issueNumber: number): Promise<RemoteIssue> {
    const { owner, repoName: repo } = ref;
    const { baseUrl, host } = this.getEndpoint(ref.url);

    const cacheKey = `gh:issue:${baseUrl}:${owner}/${repo}#${issueNumber}`;
    const cached = this.getCached<RemoteIssue>(cacheKey);
    if (cached) return cached;

    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any>(baseUrl, `/repos/${owner}/${repo}/issues/${issueNumber}`, resolvedToken);
    const issue = this.toRemoteIssue(raw);

    this.setCache(cacheKey, issue);
    return issue;
  }

  private toRemotePullRequest(raw: any): RemotePullRequest {
    let state: 'open' | 'closed' | 'merged' = raw.state;
    if (raw.merged_at || raw.merged) state = 'merged';
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? null,
      state,
      user: {
        login: raw.user?.login || '',
        avatarUrl: raw.user?.avatar_url || null,
      },
      labels: (raw.labels || []).map((l: any) => ({
        name: typeof l === 'string' ? l : l.name,
        color: typeof l === 'string' ? '' : (l.color || ''),
      })),
      htmlUrl: raw.html_url,
      headBranch: raw.head?.ref || '',
      baseBranch: raw.base?.ref || '',
      draft: raw.draft || false,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  async listPullRequests(ref: RepoRef, opts: ListPullRequestsOptions = {}): Promise<ListPullRequestsResult> {
    const { owner, repoName: repo } = ref;
    const { baseUrl, host } = this.getEndpoint(ref.url);
    const state = opts.state || 'open';
    const page = opts.page || 1;
    const perPage = opts.perPage || 20;

    const params = new URLSearchParams({
      state: state === 'all' ? 'all' : state,
      page: String(page),
      per_page: String(perPage),
      sort: 'updated',
      direction: 'desc',
    });

    const cacheKey = `gh:pulls:${baseUrl}:${owner}/${repo}?${params.toString()}`;
    if (opts.fresh) {
      this.invalidatePullListCache(baseUrl, owner, repo);
    } else {
      const cached = this.getCached<ListPullRequestsResult>(cacheKey);
      if (cached) return cached;
    }

    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any[]>(baseUrl, `/repos/${owner}/${repo}/pulls?${params.toString()}`, resolvedToken);
    const pullRequests = raw.map((pr) => this.toRemotePullRequest(pr));
    const result: ListPullRequestsResult = { pullRequests, page, hasMore: pullRequests.length === perPage };

    this.setCache(cacheKey, result, LIST_CACHE_TTL);
    return result;
  }

  async getPullRequest(ref: RepoRef, prNumber: number): Promise<RemotePullRequest> {
    const { owner, repoName: repo } = ref;
    const { baseUrl, host } = this.getEndpoint(ref.url);

    const cacheKey = `gh:pr:${baseUrl}:${owner}/${repo}#${prNumber}`;
    const cached = this.getCached<RemotePullRequest>(cacheKey);
    if (cached) return cached;

    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any>(baseUrl, `/repos/${owner}/${repo}/pulls/${prNumber}`, resolvedToken);
    const pr = this.toRemotePullRequest(raw);

    this.setCache(cacheKey, pr);
    return pr;
  }

  // findPullRequestByBranch is not cached: it backs push-completion verification,
  // which must observe the PR the instant it lands.
  async findPullRequestByBranch(ref: RepoRef, branch: string): Promise<RemotePullRequest | null> {
    const { owner, repoName: repo } = ref;
    const { baseUrl, host } = this.getEndpoint(ref.url);
    const resolvedToken = this.resolveToken(ref.token, host);

    const params = new URLSearchParams({ head: `${owner}:${branch}`, state: 'open', per_page: '1' });
    const raw = await this.request<any[]>(baseUrl, `/repos/${owner}/${repo}/pulls?${params.toString()}`, resolvedToken);
    return raw[0] ? this.toRemotePullRequest(raw[0]) : null;
  }

  private async getDefaultBranch(ref: RepoRef, baseUrl: string, resolvedToken: string | null): Promise<string> {
    const raw = await this.request<any>(baseUrl, `/repos/${ref.owner}/${ref.repoName}`, resolvedToken);
    return raw.default_branch;
  }

  async createPullRequest(ref: RepoRef, params: CreatePullRequestParams): Promise<RemotePullRequest> {
    const { owner, repoName: repo } = ref;
    const { baseUrl, host } = this.getEndpoint(ref.url);
    const resolvedToken = this.resolveToken(ref.token, host);

    const base = params.base || await this.getDefaultBranch(ref, baseUrl, resolvedToken);
    const raw = await this.request<any>(baseUrl, `/repos/${owner}/${repo}/pulls`, resolvedToken, {
      method: 'POST',
      body: JSON.stringify({ head: params.head, base, title: params.title, body: params.body }),
    });

    this.invalidatePullsCache(baseUrl, owner, repo);
    return this.toRemotePullRequest(raw);
  }
}
