import type { Database } from 'better-sqlite3';

export const version = 20;
export const description = 'Add slug column to projects';

export function up(db: Database): void {
  db.exec('ALTER TABLE projects ADD COLUMN slug TEXT');

  const rows = db.prepare('SELECT id, name FROM projects').all() as Array<{ id: number; name: string }>;
  const usedSlugs = new Set<string>();
  const updateStmt = db.prepare('UPDATE projects SET slug = ? WHERE id = ?');

  for (const row of rows) {
    let slug = row.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) slug = `project-${row.id}`;

    let final = slug;
    let counter = 2;
    while (usedSlugs.has(final)) {
      final = `${slug}-${counter}`;
      counter++;
    }
    usedSlugs.add(final);
    updateStmt.run(final, row.id);
  }

  db.exec('CREATE UNIQUE INDEX idx_projects_slug ON projects(slug)');
}
