import type { SqliteDatabase } from '../../shared/db/Database';
import { seal, open } from '../../shared/crypto/SecretBox';

interface ProjectSecretRow {
  id: number;
  project_id: number;
  name: string;
  value: string;
  created_at: string;
}

export interface ProjectSecret {
  id: number;
  projectId: number;
  name: string;
  createdAt: string;
}

export interface ProjectSecretWithValue extends ProjectSecret {
  value: string;
}

export class SqliteProjectSecretRepository {
  private findByProjectStmt;
  private findByProjectWithValuesStmt;
  private upsertStmt;
  private removeStmt;

  constructor(private db: SqliteDatabase) {
    this.findByProjectStmt = db.prepare('SELECT id, project_id, name, created_at FROM project_secrets WHERE project_id = ? ORDER BY name');
    this.findByProjectWithValuesStmt = db.prepare('SELECT * FROM project_secrets WHERE project_id = ?');
    this.upsertStmt = db.prepare(`
      INSERT INTO project_secrets (project_id, name, value)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id, name)
      DO UPDATE SET value = excluded.value
    `);
    this.removeStmt = db.prepare('DELETE FROM project_secrets WHERE project_id = ? AND name = ?');
  }

  findByProject(projectId: number): ProjectSecret[] {
    return (this.findByProjectStmt.all(projectId) as ProjectSecretRow[]).map(this.toEntity);
  }

  findByProjectWithValues(projectId: number): ProjectSecretWithValue[] {
    return (this.findByProjectWithValuesStmt.all(projectId) as ProjectSecretRow[]).map(this.toEntityWithValue);
  }

  upsert(projectId: number, name: string, value: string): void {
    this.upsertStmt.run(projectId, name, seal(value));
  }

  remove(projectId: number, name: string): boolean {
    const result = this.removeStmt.run(projectId, name);
    return result.changes > 0;
  }

  private toEntity(row: ProjectSecretRow): ProjectSecret {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      createdAt: row.created_at,
    };
  }

  private toEntityWithValue(row: ProjectSecretRow): ProjectSecretWithValue {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      value: open(row.value) as string,
      createdAt: row.created_at,
    };
  }
}
