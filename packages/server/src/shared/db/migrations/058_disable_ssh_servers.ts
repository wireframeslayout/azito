export const version = 58;
export const description = 'Disable ssh server type (migrate to ssh_disabled)';

export function up(db: import('better-sqlite3').Database): void {
  db.exec("UPDATE servers SET type = 'ssh_disabled' WHERE type = 'ssh'");
}
