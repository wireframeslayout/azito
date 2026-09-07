import type Database from 'better-sqlite3';

export const version = 73;
export const description = 'Restore mux_ref kind to tmux for windows incorrectly rewritten by 072';

function isTmuxManagedWindow(windowName: string): boolean {
  return windowName.startsWith('task-') || /--[a-z0-9]{4}$/.test(windowName);
}

export function up(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT w.id, w.mux_ref
    FROM windows w
    WHERE json_extract(w.mux_ref, '$.kind') IN ('herdr', 'zellij')
  `).all() as Array<{ id: number; mux_ref: string }>;

  if (rows.length === 0) return;

  const update = db.prepare('UPDATE windows SET mux_ref = ? WHERE id = ?');
  let restored = 0;

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.mux_ref) as { kind: string; workspace: string; window: string };
      if (isTmuxManagedWindow(parsed.window)) {
        parsed.kind = 'tmux';
        update.run(JSON.stringify(parsed), row.id);
        restored++;
      }
    } catch {
      // Skip rows with unparseable mux_ref
    }
  }

  if (restored > 0) {
    console.log(`Migration 073: restored ${restored} window(s) from herdr/zellij to tmux kind`);
  }
}
