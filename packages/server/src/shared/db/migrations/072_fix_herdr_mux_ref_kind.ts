import type Database from 'better-sqlite3';

export const version = 72;
export const description = 'Fix mux_ref kind for herdr/zellij server windows';

function isTmuxManagedWindow(windowName: string): boolean {
  return windowName.startsWith('task-') || /--[a-z0-9]{4}$/.test(windowName);
}

export function up(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT w.id, w.mux_ref, s.mux_runtime
    FROM windows w
    JOIN servers s ON w.server_name = s.name
    WHERE s.mux_runtime IN ('herdr', 'zellij')
      AND w.mux_ref LIKE '%"kind":"tmux"%'
  `).all() as Array<{ id: number; mux_ref: string; mux_runtime: string }>;

  if (rows.length === 0) return;

  const update = db.prepare('UPDATE windows SET mux_ref = ? WHERE id = ?');
  let converted = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.mux_ref) as { kind: string; workspace: string; window: string };
      if (isTmuxManagedWindow(parsed.window)) {
        skipped++;
        continue;
      }
      parsed.kind = row.mux_runtime === 'herdr' ? 'herdr' : 'zellij';
      update.run(JSON.stringify(parsed), row.id);
      converted++;
    } catch {
      // Skip rows with unparseable mux_ref
    }
  }

  if (skipped > 0) {
    console.warn(`Migration 072: skipped ${skipped} tmux-managed window(s) on herdr/zellij server(s)`);
  }
  if (converted > 0) {
    console.log(`Migration 072: converted ${converted} window(s) to herdr/zellij kind`);
  }
}
