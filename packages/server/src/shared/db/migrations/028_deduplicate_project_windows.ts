import type Database from 'better-sqlite3';

export const version = 28;
export const description = 'Deduplicate project_windows and add unique index';

export function up(db: Database.Database): void {
  const duplicates = db.prepare(`
    SELECT project_id, server_name, tmux_target
    FROM project_windows
    GROUP BY project_id, server_name, tmux_target
    HAVING COUNT(*) > 1
  `).all() as { project_id: number; server_name: string; tmux_target: string }[];

  const findBest = db.prepare(`
    SELECT id FROM project_windows
    WHERE project_id = ? AND server_name = ? AND tmux_target = ?
    ORDER BY (CASE WHEN label IS NOT NULL AND label != '' THEN 0 ELSE 1 END), id
    LIMIT 1
  `);

  const deleteOthers = db.prepare(`
    DELETE FROM project_windows
    WHERE project_id = ? AND server_name = ? AND tmux_target = ? AND id != ?
  `);

  for (const dup of duplicates) {
    const best = findBest.get(dup.project_id, dup.server_name, dup.tmux_target) as { id: number };
    deleteOthers.run(dup.project_id, dup.server_name, dup.tmux_target, best.id);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_windows_unique
    ON project_windows (project_id, server_name, tmux_target)
  `);
}
