import type Database from 'better-sqlite3';

export const version = 43;
export const description = 'Add agent_turns / agent_turn_events tables and units.worker_execution_mode for agent signal monitoring';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agent_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      unit_id INTEGER,
      kind TEXT NOT NULL,
      phase TEXT,
      nonce TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      completion_source TEXT,
      confidence TEXT,
      server_name TEXT,
      tmux_target TEXT,
      output_file_path TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
    )
  `);

  db.exec('CREATE INDEX idx_agent_turns_task ON agent_turns(task_id, id)');

  db.exec(`
    CREATE TABLE agent_turn_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      source TEXT NOT NULL DEFAULT 'http',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE CASCADE
    )
  `);

  db.exec('CREATE INDEX idx_agent_turn_events_turn ON agent_turn_events(turn_id, id)');

  db.exec(`ALTER TABLE units ADD COLUMN worker_execution_mode TEXT NOT NULL DEFAULT 'tmux-pipe'`);
}
