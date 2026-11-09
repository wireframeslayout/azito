import type Database from 'better-sqlite3';

export const version = 85;
export const description = 'Add server-owned windows and orchestrator role';

export function up(db: Database.Database): void {
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'windows'").get() as { seq: number } | undefined;
  const columns = db.prepare('PRAGMA table_info(windows)').all() as Array<{ name: string; type: string; dflt_value: string | null }>;
  const known = ['id', 'owner_type', 'project_id', 'task_id', 'server_name', 'tmux_target', 'label', 'is_primary', 'window_type', 'worker_type', 'worker_model', 'agent_session_id', 'launch_command', 'working_directory', 'pane_layout', 'created_at', 'sleeping', 'mux_ref', 'label_source', 'claude_config_dir', 'claude_pane_sessions', 'claude_config_dir_explicit'];
  const names = new Set(columns.map(c => c.name));
  for (const name of known) if (!names.has(name)) throw new Error(`085: windows is missing ${name}`);
  const extras = columns.filter(c => !known.includes(c.name));
  const extraDefs = extras.map(c => `"${c.name.replace(/"/g, '""')}" ${c.type}${c.dflt_value === null ? '' : ` DEFAULT ${c.dflt_value}`},`).join('\n');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'windows' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  db.exec(`CREATE TABLE windows_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('project', 'task', 'server')),
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    server_name TEXT NOT NULL, tmux_target TEXT NOT NULL, label TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    window_type TEXT NOT NULL DEFAULT 'terminal' CHECK (window_type IN ('terminal', 'agent')),
    worker_type TEXT, worker_model TEXT, agent_session_id TEXT, launch_command TEXT,
    working_directory TEXT, pane_layout TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sleeping INTEGER NOT NULL DEFAULT 0, mux_ref TEXT,
    label_source TEXT NOT NULL DEFAULT 'auto' CHECK (label_source IN ('auto', 'user')),
    claude_config_dir TEXT, claude_pane_sessions TEXT, claude_config_dir_explicit INTEGER,
    role TEXT CHECK (role IS NULL OR role = 'orchestrator'),
    origin_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    ${extraDefs}
    CHECK ((owner_type = 'project' AND project_id IS NOT NULL AND task_id IS NULL)
      OR (owner_type = 'task' AND task_id IS NOT NULL)
      OR (owner_type = 'server' AND project_id IS NULL AND task_id IS NULL)),
    CHECK (role IS NULL OR (owner_type = 'server' AND window_type = 'agent'))
  )`);
  const copy = columns.map(c => `"${c.name.replace(/"/g, '""')}"`).join(', ');
  db.exec(`INSERT INTO windows_new (${copy}) SELECT ${copy} FROM windows`);
  db.exec('DROP TABLE windows; ALTER TABLE windows_new RENAME TO windows');
  if (sequence) {
    const updated = db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'windows'").run(sequence.seq);
    if (!updated.changes) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('windows', ?)").run(sequence.seq);
  }
  for (const index of indexes) db.exec(index.sql);
}
