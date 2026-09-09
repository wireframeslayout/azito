import type Database from 'better-sqlite3';

export const version = 68;
export const description = 'Merge duplicate window rows (one physical window = one row) and drop pane suffix from tmux_target';

const PANE_SUFFIX_RE = /\.\d+$/;

function stripPaneSuffix(target: string): string {
  return target.replace(PANE_SUFFIX_RE, '');
}

interface WindowRow {
  id: number;
  owner_type: string;
  project_id: number | null;
  task_id: number | null;
  server_name: string;
  tmux_target: string;
  label: string | null;
  is_primary: number;
  window_type: string;
  worker_type: string | null;
  worker_model: string | null;
  agent_session_id: string | null;
  launch_command: string | null;
  working_directory: string | null;
  pane_layout: string | null;
  sleeping: number;
  created_at: string;
}

export function up(db: Database.Database): void {
  // Backup all rows before any changes
  db.exec('CREATE TABLE windows_merge_backup_068 AS SELECT * FROM windows');

  // 1. Recreate windows table with relaxed CHECK constraint.
  //    Task rows can now hold project_id (previously required NULL).
  //
  //    The live column layout of `windows` is NOT guaranteed to match a fresh
  //    migration chain: databases that lived through 050 (ADD supervised) →
  //    056 (DROP COLUMN supervised) → 063 (ADD sleeping) can differ in column
  //    order and column set from one created by the same migrations today
  //    (SQLite's DROP COLUMN rewrites the table, and older hubs may carry extra
  //    columns from intermediate releases). A positional `INSERT ... SELECT *`
  //    therefore fails with "table windows_new has N columns but M values were
  //    supplied" — observed on the server001 hub during the v0.10.0-rc.1 cutover.
  //    Copy by explicit column name instead: known columns map 1:1, and any
  //    extra live column is carried over verbatim so no data is dropped.
  const KNOWN_COLUMNS = [
    'id', 'owner_type', 'project_id', 'task_id', 'server_name', 'tmux_target', 'label',
    'is_primary', 'window_type', 'worker_type', 'worker_model', 'agent_session_id',
    'launch_command', 'working_directory', 'pane_layout', 'created_at', 'sleeping',
  ];
  const liveColumns = db.prepare('PRAGMA table_info(windows)').all() as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>;
  const liveNames = new Set(liveColumns.map((c) => c.name));
  const missingRequired = ['id', 'owner_type', 'server_name', 'tmux_target'].filter((c) => !liveNames.has(c));
  if (missingRequired.length > 0) {
    throw new Error(`068: windows table is missing required columns: ${missingRequired.join(', ')}`);
  }
  const extraColumns = liveColumns.filter((c) => !KNOWN_COLUMNS.includes(c.name));
  const extraDefs = extraColumns.map((c) => {
    const type = c.type ? ` ${c.type}` : '';
    const dflt = c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : '';
    return `      "${c.name}"${type}${dflt},\n`;
  }).join('');

  db.exec(`
    CREATE TABLE windows_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('project', 'task')),
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      tmux_target TEXT NOT NULL,
      label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      window_type TEXT NOT NULL DEFAULT 'terminal' CHECK (window_type IN ('terminal', 'agent')),
      worker_type TEXT,
      worker_model TEXT,
      agent_session_id TEXT,
      launch_command TEXT,
      working_directory TEXT,
      pane_layout TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sleeping INTEGER NOT NULL DEFAULT 0,
${extraDefs}      CHECK (
        (owner_type = 'project' AND project_id IS NOT NULL AND task_id IS NULL)
        OR (owner_type = 'task' AND task_id IS NOT NULL)
      )
    )
  `);

  // Copy only the columns that exist on the live table; columns that are new
  // to windows_new (e.g. `sleeping` on a DB where 063 was skipped) take their
  // DEFAULT. Quote every identifier — extra columns may carry arbitrary names.
  const copyColumns = [
    ...KNOWN_COLUMNS.filter((c) => liveNames.has(c)),
    ...extraColumns.map((c) => c.name),
  ].map((c) => `"${c}"`).join(', ');
  db.exec(`INSERT INTO windows_new (${copyColumns}) SELECT ${copyColumns} FROM windows`);
  db.exec('DROP TABLE windows');
  db.exec('ALTER TABLE windows_new RENAME TO windows');

  db.exec(`CREATE INDEX idx_windows_task_id ON windows (task_id) WHERE owner_type = 'task'`);

  // 2. Group by (server_name, stripped tmux_target) and merge duplicates.
  //    Keep task row (newest by created_at). Inherit project_id/label from removed rows.
  const rows = db.prepare('SELECT * FROM windows ORDER BY created_at ASC, id ASC').all() as WindowRow[];
  const groups = new Map<string, WindowRow[]>();
  for (const r of rows) {
    const key = `${r.server_name}::${stripPaneSuffix(r.tmux_target)}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(r);
  }

  let merged = 0;
  const repointStmt = db.prepare('UPDATE tasks SET pending_operation_window_id = ? WHERE pending_operation_window_id = ?');
  const deleteStmt = db.prepare('DELETE FROM windows WHERE id = ?');
  const updateKeepStmt = db.prepare(
    'UPDATE windows SET project_id = COALESCE(project_id, ?), label = COALESCE(label, ?), sleeping = MAX(sleeping, ?) WHERE id = ?',
  );

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const taskRows = group
      .filter((r) => r.owner_type === 'task')
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const keep = taskRows[0] ?? group[0];

    for (const r of group) {
      if (r.id === keep.id) continue;
      updateKeepStmt.run(r.project_id, r.label, r.sleeping ?? 0, keep.id);
      repointStmt.run(keep.id, r.id);
      deleteStmt.run(r.id);
    }
    merged++;
  }

  // 3. Strip pane suffix from all tmux_target values
  const allRows = db.prepare('SELECT id, tmux_target FROM windows').all() as { id: number; tmux_target: string }[];
  const updateTarget = db.prepare('UPDATE windows SET tmux_target = ? WHERE id = ?');
  for (const r of allRows) {
    const stripped = stripPaneSuffix(r.tmux_target);
    if (stripped !== r.tmux_target) {
      updateTarget.run(stripped, r.id);
    }
  }

  // 4. Assert no duplicates remain after merge + suffix stripping
  const dups = db.prepare(
    'SELECT server_name, tmux_target, COUNT(*) AS c FROM windows GROUP BY server_name, tmux_target HAVING c > 1',
  ).all();
  if (dups.length > 0) {
    throw new Error(`068: duplicate physical windows remain after merge: ${JSON.stringify(dups)}`);
  }

  // 5. Replace indexes: drop the old partial unique, add a full unique
  db.exec('DROP INDEX IF EXISTS idx_windows_project_unique');
  db.exec('CREATE UNIQUE INDEX idx_windows_physical_unique ON windows (server_name, tmux_target)');

  console.log(`[migration 068] merged ${merged} duplicate window groups${extraColumns.length ? ` (carried extra columns: ${extraColumns.map((c) => c.name).join(', ')})` : ''}`);
}
