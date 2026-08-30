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
  removeRepository(id: number, projectId: number): void;
}
