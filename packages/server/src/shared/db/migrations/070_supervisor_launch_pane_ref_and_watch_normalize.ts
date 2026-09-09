import type Database from 'better-sqlite3';

export const version = 70;
export const description = 'Add mux_pane_ref and window_id to supervisor_launches, normalize agent_watches target';

export function up(db: Database.Database): void {
  db.exec('ALTER TABLE supervisor_launches ADD COLUMN mux_pane_ref TEXT');
  db.exec('ALTER TABLE supervisor_launches ADD COLUMN window_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_supervisor_launches_window_id ON supervisor_launches(window_id) WHERE window_id IS NOT NULL');

  const rows = db.prepare('SELECT id, endpoint, server_name, target FROM agent_watches').all() as Array<{
    id: number; endpoint: string; server_name: string; target: string;
  }>;

  const strip = (t: string) => t.replace(/\.\d+$/, '');

  const groups = new Map<string, Array<{ id: number; target: string }>>();
  for (const row of rows) {
    const stripped = strip(row.target);
    const key = `${row.endpoint}\0${row.server_name}\0${stripped}`;
    const arr = groups.get(key) ?? [];
    arr.push({ id: row.id, target: row.target });
    groups.set(key, arr);
  }

  const deleteStmt = db.prepare('DELETE FROM agent_watches WHERE id = ?');
  for (const entries of groups.values()) {
    if (entries.length <= 1) continue;
    entries.sort((a, b) => a.id - b.id);
    for (let i = 0; i < entries.length - 1; i++) {
      deleteStmt.run(entries[i].id);
    }
  }

  const updateStmt = db.prepare('UPDATE agent_watches SET target = ? WHERE id = ?');
  for (const row of rows) {
    const stripped = strip(row.target);
    if (stripped !== row.target) {
      const exists = db.prepare('SELECT id FROM agent_watches WHERE id = ?').get(row.id);
      if (exists) {
        updateStmt.run(stripped, row.id);
      }
    }
  }
}
