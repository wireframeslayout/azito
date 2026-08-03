export const version = 54;
export const description = 'Add ssh_host_fingerprint to servers for host key pinning';
export function up(db: import('better-sqlite3').Database): void {
  db.exec('ALTER TABLE servers ADD COLUMN ssh_host_fingerprint TEXT');
}
