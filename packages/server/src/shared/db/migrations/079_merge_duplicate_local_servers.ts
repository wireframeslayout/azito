import type Database from 'better-sqlite3';

export const version = 79;
export const description = 'Merge duplicate local servers (one machine = one server) and record the old names in server_aliases (Issue #313)';

interface ServerRow { name: string; default_mux: string; mux_runtime: string; rowid: number }
interface WindowRow {
  id: number; server_name: string; tmux_target: string; mux_ref: string | null; task_id: number | null; is_primary: number;
  project_id: number | null; label: string | null; sleeping: number;
}
interface Launch { id: number; task_id: number | null; target: string; status: string }

/**
 * Every table that carries a server name, found from the schema (not from the issue's list): a row's server name is
 * moved to the merge target. `unique` tables have a UNIQUE / PRIMARY KEY that includes the server name: a moved row
 * that would collide is dropped in favour of the row the target already had. `windows` is merged separately.
 * `project_servers` is a `unique` table too: on a (project_id) conflict the target's row wins, so its working
 * directory / tmux session are the setting that stays.
 * `windows_merge_backup_068` is a historical copy and is left alone.
 */
const PLAIN_TABLES = ['tasks', 'supervisor_launches', 'agent_turns'] as const;
const UNIQUE_TABLES = ['agent_watches', 'distribution_state', 'browser_groups', 'browser_tab_snapshots', 'project_servers'] as const;

/**
 * The windows of the merged servers that name one physical window (same `(server_name, tmux_target)` or
 * `(server_name, mux_ref)` once the server names are equal) are merged into one row, as 068 / 078 did: this is
 * the same machine, so two rows for one window are one window. Throwing here would stop the hub from starting
 * unattended and the old state could not be repaired without editing the database by hand, so the migration
 * instead keeps the row of the latest task (then the target's own row), moves the references that are safe to
 * move, clears the others and warns. Nothing but a duplicate row is ever deleted.
 */
function mergeCollidingWindows(db: Database.Database, names: string[], target: string): void {
  const placeholders = names.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT id, server_name, tmux_target, mux_ref, task_id, is_primary, project_id, label, sleeping FROM windows WHERE server_name IN (${placeholders})`,
  ).all(...names) as WindowRow[];

  // Union rows that share a physical key.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const byKey = new Map<string, number>();
  for (const row of rows) {
    parent.set(row.id, row.id);
  }
  for (const row of rows) {
    for (const key of [`t\u0000${row.tmux_target}`, ...(row.mux_ref ? [`r\u0000${row.mux_ref}`] : [])]) {
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, row.id);
      else parent.set(find(row.id), find(seen));
    }
  }
  const groups = new Map<number, WindowRow[]>();
  for (const row of rows) {
    const root = find(row.id);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }

  const inherit = db.prepare('UPDATE windows SET project_id = COALESCE(project_id, ?), label = COALESCE(label, ?), sleeping = MAX(sleeping, ?) WHERE id = ?');
  const pendingOf = db.prepare('SELECT id FROM tasks WHERE pending_operation_window_id = ?');
  const setPending = db.prepare('UPDATE tasks SET pending_operation_window_id = ? WHERE id = ?');
  const launchesOf = db.prepare('SELECT id, task_id, target, status FROM supervisor_launches WHERE window_id = ?');
  const setLaunch = db.prepare('UPDATE supervisor_launches SET window_id = ? WHERE id = ?');
  const expireLaunch = db.prepare("UPDATE supervisor_launches SET window_id = NULL, status = 'expired' WHERE id = ?");
  const moveWatches = db.prepare('UPDATE agent_watches SET window_id = ? WHERE window_id = ?');
  const remove = db.prepare('DELETE FROM windows WHERE id = ?');

  const merged: number[] = [];
  const detachedTasks = new Set<number>();
  const isLive = (launch: Launch): boolean => launch.status === 'pending' || launch.status === 'active';

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const taskRows = group.filter((r) => r.task_id !== null);
    const order = (a: WindowRow, b: WindowRow): number =>
      (b.task_id ?? 0) - (a.task_id ?? 0) || (b.is_primary - a.is_primary) || ((a.server_name === target ? 0 : 1) - (b.server_name === target ? 0 : 1)) || (a.id - b.id);
    const keeper = (taskRows.length > 0 ? taskRows : group).slice().sort(order)[0];
    for (const dup of group) {
      if (dup === keeper) continue;
      inherit.run(dup.project_id, dup.label, dup.sleeping, keeper.id);
      for (const { id: taskId } of pendingOf.all(dup.id) as Array<{ id: number }>) {
        const own = keeper.task_id !== null && taskId === keeper.task_id;
        setPending.run(own ? keeper.id : null, taskId);
        if (!own) detachedTasks.add(taskId);
      }
      for (const launch of launchesOf.all(dup.id) as Launch[]) {
        const own = keeper.task_id !== null && launch.task_id === keeper.task_id;
        if (own && launch.target === keeper.tmux_target) setLaunch.run(keeper.id, launch.id);
        else if (isLive(launch)) expireLaunch.run(launch.id);
        else setLaunch.run(null, launch.id);
        if (!own && launch.task_id !== null) detachedTasks.add(launch.task_id);
      }
      moveWatches.run(keeper.id, dup.id);
      remove.run(dup.id);
      merged.push(dup.id);
    }
  }
  if (merged.length > 0) console.log(`Migration 079: merged duplicate window row(s) ${merged.join(', ')}`);
  if (detachedTasks.size > 0) {
    console.warn(`Migration 079: task(s) ${[...detachedTasks].join(', ')} pointed at a merged window row of another task; those references were cleared`);
  }
}

/**
 * `type = 'local'` servers all stand for this machine, so the ones that a server-per-mux setup created (`local`,
 * `local-misao`) are merged into one: the target is the tmux-default server with the lowest rowid (else the lowest
 * rowid), and it takes `default_mux = 'misao'` when any merged server used misao (the user's intent is kept). A
 * `tmux` server whose `mux_runtime` differs from the target's runs on another tmux socket (`-L azito`), i.e. other
 * windows, so it is not a duplicate and is left alone. Rows that name the old servers move to the target; the old
 * names are recorded in `server_aliases` so webhooks and saved tabs that still carry them resolve (1 release, #313).
 * Does nothing when there is at most one mergeable local server.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_aliases (
      old_name TEXT PRIMARY KEY,
      new_name TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const locals = db.prepare("SELECT rowid AS rowid, name, default_mux, mux_runtime FROM servers WHERE type = 'local' ORDER BY rowid").all() as ServerRow[];
  if (locals.length < 2) return;

  const target = locals.find((s) => s.default_mux === 'tmux') ?? locals[0];
  const sources: ServerRow[] = [];
  for (const server of locals) {
    if (server === target) continue;
    if (server.default_mux === 'tmux' && server.mux_runtime !== target.mux_runtime) {
      console.warn(`Migration 079: local server '${server.name}' (tmux, ${server.mux_runtime}) is not merged into '${target.name}' (${target.mux_runtime}): another tmux socket`);
      continue;
    }
    sources.push(server);
  }
  if (sources.length === 0) return;

  const sourceNames = sources.map((s) => s.name);
  const allNames = [target.name, ...sourceNames];
  mergeCollidingWindows(db, allNames, target.name);

  for (const name of sourceNames) {
    db.prepare('UPDATE windows SET server_name = ? WHERE server_name = ?').run(target.name, name);
    for (const table of PLAIN_TABLES) db.prepare(`UPDATE ${table} SET server_name = ? WHERE server_name = ?`).run(target.name, name);
    for (const table of UNIQUE_TABLES) {
      db.prepare(`UPDATE OR IGNORE ${table} SET server_name = ? WHERE server_name = ?`).run(target.name, name);
      // Rows that would collide with the target's own row stay behind under the old name: drop them.
      db.prepare(`DELETE FROM ${table} WHERE server_name = ?`).run(name);
    }
    db.prepare('UPDATE server_aliases SET new_name = ? WHERE new_name = ?').run(target.name, name);
  }

  if (sources.some((s) => s.default_mux === 'misao') && target.default_mux !== 'misao') {
    db.prepare("UPDATE servers SET default_mux = 'misao' WHERE name = ?").run(target.name);
  }
  for (const name of sourceNames) {
    db.prepare('DELETE FROM servers WHERE name = ?').run(name);
    db.prepare('INSERT OR REPLACE INTO server_aliases (old_name, new_name) VALUES (?, ?)').run(name, target.name);
  }
  console.log(`Migration 079: merged local server(s) ${sourceNames.join(', ')} into '${target.name}'`);
}
