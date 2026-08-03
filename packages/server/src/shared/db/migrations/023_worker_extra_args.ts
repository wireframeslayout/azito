export const version = 23;
export const description = 'Replace worker_command with worker_extra_args on sidekicks';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE sidekicks ADD COLUMN worker_extra_args TEXT`);
  db.exec(
    `UPDATE sidekicks SET worker_extra_args = worker_command WHERE worker_type = 'generic' OR worker_type IS NULL`,
  );
  db.exec(`ALTER TABLE sidekicks DROP COLUMN worker_command`);
}
