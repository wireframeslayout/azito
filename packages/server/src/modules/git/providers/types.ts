/** Provider操作の対象リポジトリ参照。境界（ExecuteTaskUseCase/routes）で解決して下流に渡す */
export interface RepoRef {
  provider: 'github' | 'gitlab';
  owner: string;
  repoName: string;
  /** リポジトリのwebページURL。self-hostedのbaseUrl導出に使う */
  url: string | null;
  token: string | null;
}

export interface RemoteIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string; color: string }[];
  user: { login: string; avatarUrl: string };
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface ListIssuesOptions {
  state?: 'open' | 'closed' | 'all';
  labels?: string;
  page?: number;
  perPage?: number;
  /** trueの場合キャッシュ読み取りをスキップして常に最新を取得する */
  fresh?: boolean;
}

export interface ListIssuesResult {
  issues: RemoteIssue[];
  page: number;
  hasMore: boolean;
}

export interface RemotePullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  user: { login: string; avatarUrl: string | null };
  labels: { name: string; color: string }[];
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListPullRequestsOptions {
  state?: 'open' | 'closed' | 'all';
  page?: number;
  perPage?: number;
  /** trueの場合キャッシュ読み取りをスキップして常に最新を取得する */
  fresh?: boolean;
}

export interface ListPullRequestsResult {
  pullRequests: RemotePullRequest[];
  page: number;
  hasMore: boolean;
}

export interface CreatePullRequestParams {
  head: string;
  base?: string;
  title: string;
  body?: string;
}

/**
 * アクセス可能なリポジトリ1件分のサマリ。プロジェクト作成ウィザードの候補提示
 * （リポジトリ選択API）専用。トークンやレスポンス全体は含めず、clone/表示に
 * 必要な最小フィールドのみを持つ。
 */
export interface RemoteRepositorySummary {
  provider: 'github' | 'gitlab';
  owner: string;
  repoName: string;
  /** cloneに使えるhttps URL */
  httpsUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

export interface ListAccessibleRepositoriesResult {
  repositories: RemoteRepositorySummary[];
  /** ページ上限に達し、まだ取得しきれていないリポジトリがある可能性がある場合true */
  truncated: boolean;
}

export interface IGitProviderClient {
  listIssues(ref: RepoRef, opts?: ListIssuesOptions): Promise<ListIssuesResult>;
  searchIssues(ref: RepoRef, query: string): Promise<RemoteIssue[]>;
  getIssue(ref: RepoRef, issueNumber: number): Promise<RemoteIssue>;
  listPullRequests(ref: RepoRef, opts?: ListPullRequestsOptions): Promise<ListPullRequestsResult>;
  getPullRequest(ref: RepoRef, prNumber: number): Promise<RemotePullRequest>;
  /** 指定ブランチをheadとするopen PR/MRを返す（無ければnull） */
  findPullRequestByBranch(ref: RepoRef, branch: string): Promise<RemotePullRequest | null>;
  /** PR/MRを作成して返す */
  createPullRequest(ref: RepoRef, params: CreatePullRequestParams): Promise<RemotePullRequest>;
  /** ブランチの HEAD SHA を返す。ブランチ不在なら null、リポジトリ不在なら throw */
  getBranchHeadSha(ref: RepoRef, branch: string): Promise<string | null>;
  /**
   * 認証中ユーザーがアクセス可能なリポジトリを一覧する（プロジェクト未登録の
   * 状態で呼ぶための、RepoRefに紐づかない入口）。ページ上限あり
   * （{@link ListAccessibleRepositoriesResult.truncated} 参照）。
   */
  listAccessibleRepositories(token: string | null): Promise<ListAccessibleRepositoriesResult>;
}
