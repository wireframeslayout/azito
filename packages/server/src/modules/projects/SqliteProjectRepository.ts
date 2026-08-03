import type { SqliteDatabase } from '../../shared/db/Database';
import { seal, open } from '../../shared/crypto/SecretBox';
import type {
  Project,
  ProjectDetail,
  ProjectRepositoryWithToken as ProjectRepoWithToken,
  IProjectRepository,
  RepositoryProvider,
} from './Project';
import type { IWindowRepository } from '../windows/Window';

interface ProjectRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  repository_url: string | null;
  default_branch: string | null;
  sidekick_prompt: string | null;
  icon: string | null;
  color: string | null;
  default_unit_id: number | null;
  created_at: string;
  updated_at: string;
}

interface RepoRow {
  id: number;
  project_id: number;
  url: string;
  name: string | null;
  provider: string;
  owner: string | null;
  repo_name: string | null;
  token: string | null;
}

export class SqliteProjectRepository implements IProjectRepository {
  private listStmt;
  private getStmt;
  private createStmt;
  private updateStmt;
  private deleteStmt;
  private listReposStmt;
  private getRepoStmt;
  private addRepoStmt;
  private deleteRepoStmt;

  constructor(private db: SqliteDatabase, private windowRepo: IWindowRepository) {
    this.listStmt = db.prepare('SELECT * FROM projects ORDER BY created_at DESC');
    this.getStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.createStmt = db.prepare('INSERT INTO projects (name, slug, description, repository_url, default_branch, sidekick_prompt) VALUES (?, ?, ?, ?, ?, ?)');
    this.updateStmt = db.prepare("UPDATE projects SET name = ?, slug = ?, description = ?, repository_url = ?, default_branch = ?, sidekick_prompt = ?, icon = ?, color = ?, default_unit_id = ?, updated_at = datetime('now') WHERE id = ?");
    this.deleteStmt = db.prepare('DELETE FROM projects WHERE id = ?');

    this.listReposStmt = db.prepare('SELECT * FROM project_repositories WHERE project_id = ?');
    this.getRepoStmt = db.prepare('SELECT * FROM project_repositories WHERE id = ?');
    this.addRepoStmt = db.prepare('INSERT INTO project_repositories (project_id, url, name, provider, owner, repo_name, token) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.deleteRepoStmt = db.prepare('DELETE FROM project_repositories WHERE id = ? AND project_id = ?');
  }

  findAll(): ProjectDetail[] {
    const rows = this.listStmt.all() as ProjectRow[];
    return rows.map((r) => this.toDetail(r));
  }

  findById(id: number): ProjectDetail | null {
    const row = this.getStmt.get(id) as ProjectRow | undefined;
    return row ? this.toDetail(row) : null;
  }

  create(name: string, slug: string, description?: string, sidekickPrompt?: string): number {
    const result = this.createStmt.run(name, slug, description ?? null, null, 'main', sidekickPrompt ?? null);
    return Number(result.lastInsertRowid);
  }

  update(id: number, data: Partial<Pick<Project, 'name' | 'slug' | 'description' | 'repositoryUrl' | 'defaultBranch' | 'sidekickPrompt' | 'icon' | 'color' | 'defaultUnitId'>>): void {
    const current = this.getStmt.get(id) as ProjectRow | undefined;
    if (!current) return;
    this.updateStmt.run(
      data.name ?? current.name,
      data.slug ?? current.slug,
      data.description ?? current.description,
      data.repositoryUrl !== undefined ? data.repositoryUrl : current.repository_url,
      data.defaultBranch !== undefined ? data.defaultBranch : current.default_branch,
      data.sidekickPrompt !== undefined ? data.sidekickPrompt : current.sidekick_prompt,
      data.icon !== undefined ? data.icon : current.icon,
      data.color !== undefined ? data.color : current.color,
      data.defaultUnitId !== undefined ? data.defaultUnitId : current.default_unit_id,
      id,
    );
  }

  delete(id: number): void {
    this.deleteStmt.run(id);
  }

  addRepository(projectId: number, url: string, name?: string, provider?: RepositoryProvider, owner?: string, repoName?: string, token?: string): number {
    const result = this.addRepoStmt.run(projectId, url, name ?? null, provider ?? 'github', owner ?? null, repoName ?? null, seal(token ?? null));
    return Number(result.lastInsertRowid);
  }

  removeRepository(id: number, projectId: number): void {
    this.deleteRepoStmt.run(id, projectId);
  }

  findRepositoryById(id: number): ProjectRepoWithToken | null {
    const row = this.getRepoStmt.get(id) as RepoRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      provider: (row.provider || 'github') as RepositoryProvider,
      owner: row.owner,
      repoName: row.repo_name,
      token: open(row.token),
    };
  }

  private toDetail(row: ProjectRow): ProjectDetail {
    const repoRows = this.listReposStmt.all(row.id) as RepoRow[];

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      repositoryUrl: row.repository_url,
      defaultBranch: row.default_branch,
      sidekickPrompt: row.sidekick_prompt,
      icon: row.icon,
      color: row.color,
      defaultUnitId: row.default_unit_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      repositories: repoRows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        provider: (r.provider || 'github') as RepositoryProvider,
        owner: r.owner,
        repoName: r.repo_name,
        hasToken: r.token != null,
      })),
      windows: this.windowRepo.findByProject(row.id),
    };
  }
}
