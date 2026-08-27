import { execFileSync } from 'child_process';
import type {
  RemoteIssue, ListIssuesOptions, ListIssuesResult,
  RemotePullRequest, ListPullRequestsOptions, ListPullRequestsResult,
  IGitProviderClient, RepoRef, CreatePullRequestParams,
} from './types';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL = 5 * 60 * 1000;
const LIST_CACHE_TTL = 60 * 1000;

export class GitLabClient implements IGitProviderClient {
  private cache = new Map<string, CacheEntry<unknown>>();
  private glabTokens = new Map<string, string | null>();

  private getGlabToken(host: string): string | null {
    if (this.glabTokens.has(host)) return this.glabTokens.get(host)!;
    try {
      // host comes from a repo URL and must never reach a shell; pass it as an argv element, not interpolated text.
      const token = execFileSync('glab', ['config', 'get', 'token', '-h', host], { encoding: 'utf-8', timeout: 5000 }).trim();
      this.glabTokens.set(host, token || null);
      return token || null;
    } catch {
      this.glabTokens.set(host, null);
      return null;
    }
  }

  private resolveToken(repoToken: string | null, host: string): string | null {
    return repoToken || this.getGlabToken(host);
  }

  private getBaseUrl(repoUrl: string | null): string {
    if (!repoUrl) return 'https://gitlab.com';
    try {
      const url = new URL(repoUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      return 'https://gitlab.com';
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

  /** Invalidates cached merge-request listings/lookups for a project after a mutation (createPullRequest). */
  private invalidateMrCache(baseUrl: string, owner: string, repo: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`gl:mrs:${baseUrl}:${owner}/${repo}`) || key.startsWith(`gl:mr:${baseUrl}:${owner}/${repo}`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Invalidates all cached issue listing pages for a repo (used when opts.fresh, so a later Load more never reads a stale page). */
  private invalidateIssueListCache(baseUrl: string, owner: string, repo: string): void {
    const prefix = `gl:list:${baseUrl}:${owner}/${repo}`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Invalidates all cached merge-request listing pages for a project (used when opts.fresh, so a later Load more never reads a stale page). */
  private invalidateMrListCache(baseUrl: string, owner: string, repo: string): void {
    const prefix = `gl:mrs:${baseUrl}:${owner}/${repo}`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private async request<T>(baseUrl: string, path: string, token: string | null, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['PRIVATE-TOKEN'] = token;

    const res = await fetch(`${baseUrl}/api/v4${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitLab API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private toRemoteIssue(raw: any, baseUrl: string, owner: string, repo: string): RemoteIssue {
    return {
      number: raw.iid,
      title: raw.title,
      body: raw.description ?? null,
      state: raw.state === 'opened' ? 'open' : raw.state,
      labels: (raw.labels || []).map((l: string) => ({ name: l, color: '' })),
      user: {
        login: raw.author?.username || '',
        avatarUrl: raw.author?.avatar_url || '',
      },
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      htmlUrl: raw.web_url || `${baseUrl}/${owner}/${repo}/-/issues/${raw.iid}`,
    };
  }

  private mapState(state: string): string {
    if (state === 'open') return 'opened';
    if (state === 'closed') return 'closed';
    return 'all';
  }

  async listIssues(ref: RepoRef, opts: ListIssuesOptions = {}): Promise<ListIssuesResult> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const state = opts.state || 'open';
    const page = opts.page || 1;
    const perPage = opts.perPage || 20;

    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const params = new URLSearchParams({
      page: String(page), per_page: String(perPage), order_by: 'updated_at', sort: 'desc',
    });
    if (state !== 'all') params.set('state', this.mapState(state));
    if (opts.labels) params.set('labels', opts.labels);

    const cacheKey = `gl:list:${baseUrl}:${owner}/${repo}?${params.toString()}`;
    if (opts.fresh) {
      this.invalidateIssueListCache(baseUrl, owner, repo);
    } else {
      const cached = this.getCached<ListIssuesResult>(cacheKey);
      if (cached) return cached;
    }

    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any[]>(baseUrl, `/projects/${projectPath}/issues?${params.toString()}`, resolvedToken);
    const issues = raw.map((i) => this.toRemoteIssue(i, baseUrl, owner, repo));
    const result: ListIssuesResult = { issues, page, hasMore: issues.length === perPage };

    this.setCache(cacheKey, result, LIST_CACHE_TTL);
    return result;
  }

  async searchIssues(ref: RepoRef, query: string): Promise<RemoteIssue[]> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const projectPath = encodeURIComponent(`${owner}/${repo}`);

    const cacheKey = `gl:search:${baseUrl}:${owner}/${repo}:${query}`;
    const cached = this.getCached<RemoteIssue[]>(cacheKey);
    if (cached) return cached;

    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);
    const params = new URLSearchParams({ search: query, per_page: '30', order_by: 'updated_at', sort: 'desc' });
    const raw = await this.request<any[]>(baseUrl, `/projects/${projectPath}/issues?${params.toString()}`, resolvedToken);
    const issues = raw.map((i) => this.toRemoteIssue(i, baseUrl, owner, repo));

    this.setCache(cacheKey, issues);
    return issues;
  }

  async getIssue(ref: RepoRef, issueNumber: number): Promise<RemoteIssue> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const projectPath = encodeURIComponent(`${owner}/${repo}`);

    const cacheKey = `gl:issue:${baseUrl}:${owner}/${repo}#${issueNumber}`;
    const cached = this.getCached<RemoteIssue>(cacheKey);
    if (cached) return cached;

    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any>(baseUrl, `/projects/${projectPath}/issues/${issueNumber}`, resolvedToken);
    const issue = this.toRemoteIssue(raw, baseUrl, owner, repo);

    this.setCache(cacheKey, issue);
    return issue;
  }

  private toRemotePullRequest(raw: any, baseUrl: string, owner: string, repo: string): RemotePullRequest {
    let state: 'open' | 'closed' | 'merged' = 'open';
    if (raw.state === 'merged') state = 'merged';
    else if (raw.state === 'closed') state = 'closed';
    else if (raw.state === 'opened') state = 'open';

    return {
      number: raw.iid,
      title: raw.title,
      body: raw.description ?? null,
      state,
      user: {
        login: raw.author?.username || '',
        avatarUrl: raw.author?.avatar_url || null,
      },
      labels: (raw.labels || []).map((l: string) => ({ name: l, color: '' })),
      htmlUrl: raw.web_url || `${baseUrl}/${owner}/${repo}/-/merge_requests/${raw.iid}`,
      headBranch: raw.source_branch || '',
      baseBranch: raw.target_branch || '',
      draft: raw.draft || raw.work_in_progress || false,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  private mapMrState(state: string): string {
    if (state === 'open') return 'opened';
    if (state === 'closed') return 'closed';
    if (state === 'merged') return 'merged';
    return 'all';
  }

  async listPullRequests(ref: RepoRef, opts: ListPullRequestsOptions = {}): Promise<ListPullRequestsResult> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const state = opts.state || 'open';
    const page = opts.page || 1;
    const perPage = opts.perPage || 20;

    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      order_by: 'updated_at',
      sort: 'desc',
    });
    if (state !== 'all') params.set('state', this.mapMrState(state));

    const cacheKey = `gl:mrs:${baseUrl}:${owner}/${repo}?${params.toString()}`;
    if (opts.fresh) {
      this.invalidateMrListCache(baseUrl, owner, repo);
    } else {
      const cached = this.getCached<ListPullRequestsResult>(cacheKey);
      if (cached) return cached;
    }

    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any[]>(baseUrl, `/projects/${projectPath}/merge_requests?${params.toString()}`, resolvedToken);
    const pullRequests = raw.map((mr) => this.toRemotePullRequest(mr, baseUrl, owner, repo));
    const result: ListPullRequestsResult = { pullRequests, page, hasMore: pullRequests.length === perPage };

    this.setCache(cacheKey, result, LIST_CACHE_TTL);
    return result;
  }

  async getPullRequest(ref: RepoRef, prNumber: number): Promise<RemotePullRequest> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const projectPath = encodeURIComponent(`${owner}/${repo}`);

    const cacheKey = `gl:mr:${baseUrl}:${owner}/${repo}!${prNumber}`;
    const cached = this.getCached<RemotePullRequest>(cacheKey);
    if (cached) return cached;

    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);
    const raw = await this.request<any>(baseUrl, `/projects/${projectPath}/merge_requests/${prNumber}`, resolvedToken);
    const pr = this.toRemotePullRequest(raw, baseUrl, owner, repo);

    this.setCache(cacheKey, pr);
    return pr;
  }

  // findPullRequestByBranch is not cached: it backs push-completion verification,
  // which must observe the MR the instant it lands.
  async findPullRequestByBranch(ref: RepoRef, branch: string): Promise<RemotePullRequest | null> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);

    const params = new URLSearchParams({ state: 'opened', source_branch: branch, per_page: '1' });
    const raw = await this.request<any[]>(baseUrl, `/projects/${projectPath}/merge_requests?${params.toString()}`, resolvedToken);
    return raw[0] ? this.toRemotePullRequest(raw[0], baseUrl, owner, repo) : null;
  }

  private async getDefaultBranch(projectPath: string, baseUrl: string, resolvedToken: string | null): Promise<string> {
    const raw = await this.request<any>(baseUrl, `/projects/${projectPath}`, resolvedToken);
    return raw.default_branch;
  }

  async getBranchHeadSha(ref: RepoRef, branch: string): Promise<string | null> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);
    try {
      const raw = await this.request<any>(baseUrl, `/projects/${projectPath}/repository/branches/${encodeURIComponent(branch)}`, resolvedToken);
      return raw?.commit?.id ?? null;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async createPullRequest(ref: RepoRef, params: CreatePullRequestParams): Promise<RemotePullRequest> {
    const { owner, repoName: repo } = ref;
    const baseUrl = this.getBaseUrl(ref.url);
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const host = new URL(baseUrl).host;
    const resolvedToken = this.resolveToken(ref.token, host);

    const target = params.base || await this.getDefaultBranch(projectPath, baseUrl, resolvedToken);
    const raw = await this.request<any>(baseUrl, `/projects/${projectPath}/merge_requests`, resolvedToken, {
      method: 'POST',
      body: JSON.stringify({
        source_branch: params.head,
        target_branch: target,
        title: params.title,
        description: params.body,
      }),
    });

    this.invalidateMrCache(baseUrl, owner, repo);
    return this.toRemotePullRequest(raw, baseUrl, owner, repo);
  }
}
