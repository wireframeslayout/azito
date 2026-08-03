export const version = 45;
export const description = 'Add mux_runtime column to servers';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE servers ADD COLUMN mux_runtime TEXT NOT NULL DEFAULT 'system'`);
}
