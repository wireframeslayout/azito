import type Database from 'better-sqlite3';

export const version = 71;
export const description = 'Add window_id to agent_watches and backfill from windows table';

export function up(db: Database.Database): void {
  db.exec('ALTER TABLE agent_watches ADD COLUMN window_id INTEGER REFERENCES windows(id) ON DELETE SET NULL');
  db.exec(`
    UPDATE agent_watches SET window_id = (
      SELECT w.id FROM windows w
      WHERE w.server_name = agent_watches.server_name
        AND w.tmux_target = agent_watches.target
    )
  `);
}
