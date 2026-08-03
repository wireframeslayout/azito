import type { Database } from 'better-sqlite3';

export const version = 7;
export const description = 'Add provider, owner, repo_name, token to project_repositories';

export function up(db: Database): void {
  db.exec(`ALTER TABLE project_repositories ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'`);
  db.exec(`ALTER TABLE project_repositories ADD COLUMN owner TEXT`);
  db.exec(`ALTER TABLE project_repositories ADD COLUMN repo_name TEXT`);
  db.exec(`ALTER TABLE project_repositories ADD COLUMN token TEXT`);

  // Auto-populate owner/repo_name from existing GitHub URLs
  const rows = db.prepare('SELECT id, url FROM project_repositories').all() as Array<{ id: number; url: string }>;
  const update = db.prepare('UPDATE project_repositories SET owner = ?, repo_name = ? WHERE id = ?');
  for (const row of rows) {
    const match = row.url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) {
      update.run(match[1], match[2], row.id);
    }
  }
}
