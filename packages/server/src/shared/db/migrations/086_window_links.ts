import type Database from 'better-sqlite3';

export const version = 86;
export const description = 'Add orchestration window links';

export function up(db: Database.Database): void {
  db.exec(`CREATE TABLE window_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_window_id INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
    target_window_id INTEGER REFERENCES windows(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('orchestration', 'operation')),
    source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interaction_at TEXT,
    unlinked_at TEXT,
    CHECK ((target_window_id IS NULL) <> (task_id IS NULL)),
    CHECK (source_window_id IS NOT target_window_id)
  );
  CREATE UNIQUE INDEX idx_window_links_window ON window_links(source_window_id, target_window_id) WHERE target_window_id IS NOT NULL;
  CREATE UNIQUE INDEX idx_window_links_task ON window_links(source_window_id, task_id) WHERE task_id IS NOT NULL;
  CREATE INDEX idx_window_links_target ON window_links(target_window_id) WHERE target_window_id IS NOT NULL;`);
}
