import type {
  IGitProviderClient, ListIssuesOptions, ListIssuesResult, RemoteIssue,
  ListPullRequestsOptions, ListPullRequestsResult, RemotePullRequest,
  RepoRef, CreatePullRequestParams,
} from './types';
import type { ProjectRepositoryWithToken as ProjectRepository } from '../../projects/Project';
import { GitHubClient } from './GitHubClient';
import { GitLabClient } from './GitLabClient';

export class GitProviderService {
  private github = new GitHubClient();
  private gitlab = new GitLabClient();

  private getClient(provider: RepoRef['provider']): IGitProviderClient {
    if (provider === 'gitlab') return this.gitlab;
    return this.github;
  }

  /**
   * Builds the provider-agnostic RepoRef from a ProjectRepository. Owner/repoName
   * presence is validated once here instead of scattered across every call site.
   */
  toRepoRef(repo: ProjectRepository): RepoRef {
    if (!repo.owner || !repo.repoName) throw new Error('Repository owner and name required');
    return {
      provider: repo.provider === 'gitlab' ? 'gitlab' : 'github',
      owner: repo.owner,
      repoName: repo.repoName,
      url: repo.url,
      token: repo.token,
    };
  }

  async listIssues(repo: ProjectRepository, opts?: ListIssuesOptions): Promise<ListIssuesResult> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).listIssues(ref, opts);
  }

  async searchIssues(repo: ProjectRepository, query: string): Promise<RemoteIssue[]> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).searchIssues(ref, query);
  }

  async getIssue(repo: ProjectRepository, issueNumber: number): Promise<RemoteIssue> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).getIssue(ref, issueNumber);
  }

  async listPullRequests(repo: ProjectRepository, opts?: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).listPullRequests(ref, opts);
  }

  async getPullRequest(repo: ProjectRepository, prNumber: number): Promise<RemotePullRequest> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).getPullRequest(ref, prNumber);
  }

  async findPullRequestByBranch(repo: ProjectRepository, branch: string): Promise<RemotePullRequest | null> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).findPullRequestByBranch(ref, branch);
  }

  async createPullRequest(repo: ProjectRepository, params: CreatePullRequestParams): Promise<RemotePullRequest> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).createPullRequest(ref, params);
  }

  async getBranchHeadSha(repo: ProjectRepository, branch: string): Promise<string | null> {
    const ref = this.toRepoRef(repo);
    return this.getClient(ref.provider).getBranchHeadSha(ref, branch);
  }
}
