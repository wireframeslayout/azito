import type Database from 'better-sqlite3';

export const version = 72;
export const description = 'Fix mux_ref kind for herdr/zellij server windows';

export function up(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT w.id, w.mux_ref, s.mux_runtime
    FROM windows w
    JOIN servers s ON w.server_name = s.name
    WHERE s.mux_runtime IN ('herdr', 'zellij')
      AND w.mux_ref LIKE '%"kind":"tmux"%'
  `).all() as Array<{ id: number; mux_ref: string; mux_runtime: string }>;

  const update = db.prepare('UPDATE windows SET mux_ref = ? WHERE id = ?');
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.mux_ref) as { kind: string; workspace: string; window: string };
      parsed.kind = row.mux_runtime === 'herdr' ? 'herdr' : 'zellij';
      update.run(JSON.stringify(parsed), row.id);
    } catch {
      // Skip rows with unparseable mux_ref
    }
  }
}
