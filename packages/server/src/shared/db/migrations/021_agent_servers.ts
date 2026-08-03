export const version = 21;
export const description = 'Add agent_port and agent_token columns to servers';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE servers ADD COLUMN agent_port INTEGER`);
  db.exec(`ALTER TABLE servers ADD COLUMN agent_token TEXT`);
}
