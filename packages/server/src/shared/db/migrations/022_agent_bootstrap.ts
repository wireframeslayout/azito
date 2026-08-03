export const version = 22;
export const description = 'Add agent_version and ssh_host columns to servers';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE servers ADD COLUMN agent_version TEXT`);
  db.exec(`ALTER TABLE servers ADD COLUMN ssh_host TEXT`);
}
