export interface Project {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  sidekickPrompt: string | null;
  icon: string | null;
  color: string | null;
  /** Default Unit for tasks in this project when the task itself has no override. */
  defaultUnitId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type RepositoryProvider = 'github' | 'gitlab' | 'other';

export interface ProjectRepository {
  id: number;
  name: string | null;
  url: string;
  provider: RepositoryProvider;
  owner: string | null;
  repoName: string | null;
  hasToken: boolean;
}

export interface ProjectRepositoryWithToken extends Omit<ProjectRepository, 'hasToken'> {
  token: string | null;
}

/**
 * Why a repository's stored credential could (or could not) be read
 * (Issue #87 配信状態の可視化). `unreadable` covers a stored value the
 * master key can no longer decrypt (key rotated/replaced, ciphertext
 * corrupted) — a real, actionable configuration state that must NOT surface
 * as a thrown error on a read-only listing path.
 */
export type RepositoryCredentialStatus = 'ok' | 'absent' | 'unreadable';

/**
 * A project repository row together with the OUTCOME of decrypting its
 * credential, for read paths that must survive a broken credential
 * (Issue #87 配信状態の可視化) — see
 * {@link IProjectRepository.findRepositoryCredentialsByIds}.
 */
export interface ProjectRepositoryCredential extends Omit<ProjectRepository, 'hasToken'> {
  credentialStatus: RepositoryCredentialStatus;
  /** Non-null only when `credentialStatus === 'ok'`. Never serialize this. */
  token: string | null;
}

export interface ProjectDetail extends Project {
  repositories: ProjectRepository[];
  windows: import('../windows/Window').Window[];
}

export interface IProjectRepository {
  findAll(): ProjectDetail[];
  findById(id: number): ProjectDetail | null;
  create(name: string, slug: string, description?: string, sidekickPrompt?: string): number;
  update(id: number, data: Partial<Pick<Project, 'name' | 'slug' | 'description' | 'repositoryUrl' | 'defaultBranch' | 'sidekickPrompt' | 'icon' | 'color' | 'defaultUnitId'>>): void;
  delete(id: number): void;
  addRepository(projectId: number, url: string, name?: string, provider?: RepositoryProvider, owner?: string, repoName?: string, token?: string): number;
  updateRepositoryToken(id: number, token: string): void;
  findRepositoryById(id: number): ProjectRepositoryWithToken | null;
  /**
   * The rows for `ids` in ONE query, each carrying its credential's
   * decryption OUTCOME instead of throwing (Issue #87 配信状態の可視化).
   *
   * `findRepositoryById` decrypts eagerly and propagates a `SecretBox.open()`
   * failure — correct for an execution path that cannot proceed without the
   * credential, but fatal for a listing that merely REPORTS configuration
   * health: one repository whose ciphertext no longer decrypts would take
   * down the whole response. This variant reports that per row instead, so a
   * broken credential degrades exactly one entry.
   *
   * Missing ids are simply absent from the result; `[]` in, `[]` out (no
   * query issued).
   */
  findRepositoryCredentialsByIds(ids: number[]): ProjectRepositoryCredential[];
  removeRepository(id: number, projectId: number): void;
}
