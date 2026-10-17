import type Database from 'better-sqlite3';

export const version = 79;
export const description = 'Merge duplicate local servers (one machine = one server) and record the old names in server_aliases (Issue #313)';

// Same ULID alphabet as misao's protocol primitives (see @azito/shared mux.ts). Duplicated, as in 078, so the
// migration keeps working whatever the shared helpers become.
const MISAO_WINDOW_ID_RE = /^w_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

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

function refKind(muxRef: string | null): string | null {
  if (!muxRef) return null;
  try {
    const kind = (JSON.parse(muxRef) as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : null;
  } catch {
    return null;
  }
}

/** The mux a window row belongs to: its ref's kind, else misao when its target names a misao window id, else tmux. */
function kindOf(row: WindowRow): string {
  const fromRef = refKind(row.mux_ref);
  if (fromRef) return fromRef;
  const sep = row.tmux_target.indexOf(':');
  return sep !== -1 && MISAO_WINDOW_ID_RE.test(row.tmux_target.slice(sep + 1)) ? 'misao' : 'tmux';
}

/**
 * Groups the rows that stand for one physical window: the same `mux_ref` (it carries the kind), or the same
 * `tmux_target` of the same kind. A tmux window and a misao window may carry the same name, which makes them
 * different windows, so a shared target alone is not an identity.
 */
function windowComponents(rows: WindowRow[]): Map<number, WindowRow[]> {
  const parent = new Map<number, number>(rows.map((r) => [r.id, r.id]));
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const byKey = new Map<string, number>();
  for (const row of rows) {
    for (const key of [`t\u0000${kindOf(row)}\u0000${row.tmux_target}`, ...(row.mux_ref ? [`r\u0000${row.mux_ref}`] : [])]) {
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
  return groups;
}

const windowsOf = (db: Database.Database, names: string[]): WindowRow[] =>
  db.prepare(
    `SELECT id, server_name, tmux_target, mux_ref, task_id, is_primary, project_id, label, sleeping FROM windows WHERE server_name IN (${names.map(() => '?').join(', ')})`,
  ).all(...names) as WindowRow[];

/**
 * Admits the sources one by one (in rowid order) into the merge: a source whose windows would clash on
 * `(server_name, tmux_target)` with a DIFFERENT window (a tmux and a misao window with one name) of the target or of an
 * already admitted source stays out. Nothing is deleted for it: it stays a server of its own with its rows. A later
 * source is judged only against what was admitted, so a source blocked by an excluded one is not blocked itself.
 */
function findBlockedSources(db: Database.Database, target: string, sources: string[]): Set<string> {
  const blocked = new Set<string>();
  const admitted: string[] = [];
  for (const source of sources) {
    const rows = windowsOf(db, [target, ...admitted, source]);
    const component = new Map<number, number>();
    for (const [root, members] of windowComponents(rows)) members.forEach((m) => component.set(m.id, root));
    const takenBy = new Map<string, Set<number | undefined>>();
    for (const row of rows) {
      if (row.server_name === source) continue;
      takenBy.set(row.tmux_target, (takenBy.get(row.tmux_target) ?? new Set()).add(component.get(row.id)));
    }
    const clashes = rows.some((row) => row.server_name === source && takenBy.has(row.tmux_target) && !takenBy.get(row.tmux_target)!.has(component.get(row.id)));
    if (clashes) blocked.add(source);
    else admitted.push(source);
  }
  return blocked;
}

/**
 * The windows of the merged servers that name one physical window (see windowComponents) are merged into one row, as
 * 068 / 078 did: this is the same machine, so two rows for one window are one window. Throwing here would stop the
 * hub from starting unattended and the old state could not be repaired without editing the database by hand, so the
 * migration instead keeps the row of the latest task (then the target's own row), moves the references that are safe
 * to move, clears the others and warns. Nothing but a duplicate row is ever deleted.
 */
function mergeCollidingWindows(db: Database.Database, names: string[], target: string): void {
  const groups = windowComponents(windowsOf(db, names));

  const inherit = db.prepare('UPDATE windows SET project_id = COALESCE(project_id, ?), label = COALESCE(label, ?), sleeping = MAX(sleeping, ?) WHERE id = ?');
  const pendingOf = db.prepare('SELECT id FROM tasks WHERE pending_operation_window_id = ?');
  const setPending = db.prepare('UPDATE tasks SET pending_operation_window_id = ? WHERE id = ?');
  // A launch is tied to a window by `window_id`; older ones (070 did not backfill it) only by (server_name, target).
  const launchesOf = db.prepare('SELECT id, task_id, target, status FROM supervisor_launches WHERE window_id = ? OR (window_id IS NULL AND server_name = ? AND target = ?)');
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
      for (const launch of launchesOf.all(dup.id, dup.server_name, dup.tmux_target) as Launch[]) {
        const own = keeper.task_id !== null && launch.task_id === keeper.task_id;
        if (own && launch.target === keeper.tmux_target) setLaunch.run(keeper.id, launch.id);
        else if (isLive(launch)) expireLaunch.run(launch.id);
        else setLaunch.run(null, launch.id);
        if (!own && launch.task_id !== null) detachedTasks.add(launch.task_id);
      }
      // A watch follows the physical window, whichever row stood for it.
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
 * Once the server names are equal, at most one pending/active launch may stand per (server_name, target) (a new launch
 * supersedes the earlier ones): the newest stays (tied to its window when that is unique), the others are `replaced`.
 */
function supersedeDuplicateLaunches(db: Database.Database, server: string): void {
  const live = db.prepare("SELECT id, target, window_id FROM supervisor_launches WHERE server_name = ? AND status IN ('pending', 'active') ORDER BY id DESC").all(server) as Array<{ id: number; target: string; window_id: number | null }>;
  const seen = new Set<string>();
  const replace = db.prepare("UPDATE supervisor_launches SET status = 'replaced' WHERE id = ?");
  const windowsOfTarget = db.prepare('SELECT id FROM windows WHERE server_name = ? AND tmux_target = ?');
  const attach = db.prepare('UPDATE supervisor_launches SET window_id = ? WHERE id = ?');
  for (const launch of live) {
    if (seen.has(launch.target)) { replace.run(launch.id); continue; }
    seen.add(launch.target);
    // The launch that stays is found through its window (`findActiveByWindow`): attach it when the window is unique.
    if (launch.window_id !== null) continue;
    const windows = windowsOfTarget.all(server, launch.target) as Array<{ id: number }>;
    if (windows.length === 1) attach.run(windows[0].id, launch.id);
  }
}

/**
 * `type = 'local'` servers all stand for this machine, so the ones that a server-per-mux setup created (`local`,
 * `local-misao`) are merged into one: the target is the tmux-default server with the lowest rowid (else the lowest
 * rowid), and it takes `default_mux = 'misao'` when any merged server used misao (the user's intent is kept).
 *
 * A local server stays out of the merge (with a warning, nothing deleted) when
 * - its `mux_runtime` differs from the target's: it runs tmux on another socket (`-L azito`), whatever its
 *   `default_mux`, so its tmux windows are other windows than the target's;
 * - one of its windows would clash on `(server_name, tmux_target)` with a different window of the same name.
 * Servers that stay are still `type = local`; listing the same misao daemon more than once is #327's concern.
 *
 * Rows that name the merged servers move to the target; the old names are recorded in `server_aliases` so webhooks,
 * supervisors and saved tabs that still carry them resolve (1 release, #313). Does nothing when fewer than two
 * servers can be merged.
 *
 * TODO(#313): when the aliases are removed (the release after this one), every pane's hook configuration must no
 * longer name an old server: re-run `harness/setup.sh --server-name <merge target>` on this machine first.
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
  const candidates: ServerRow[] = [];
  for (const server of locals) {
    if (server === target) continue;
    if (server.mux_runtime !== target.mux_runtime) {
      console.warn(`Migration 079: local server '${server.name}' (${server.default_mux}, ${server.mux_runtime}) is not merged into '${target.name}' (${target.mux_runtime}): another tmux socket (listing the same misao daemon twice is #327)`);
      continue;
    }
    candidates.push(server);
  }
  const blocked = findBlockedSources(db, target.name, candidates.map((s) => s.name));
  for (const name of blocked) {
    console.warn(`Migration 079: local server '${name}' is not merged into '${target.name}': a window of the same name exists there as a different window (a tmux and a misao window); its rows stay on '${name}'`);
  }
  const sources = candidates.filter((s) => !blocked.has(s.name));
  if (sources.length === 0) return;

  const sourceNames = sources.map((s) => s.name);
  mergeCollidingWindows(db, [target.name, ...sourceNames], target.name);

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
  supersedeDuplicateLaunches(db, target.name);

  if (sources.some((s) => s.default_mux === 'misao') && target.default_mux !== 'misao') {
    db.prepare("UPDATE servers SET default_mux = 'misao' WHERE name = ?").run(target.name);
  }
  for (const name of sourceNames) {
    db.prepare('DELETE FROM servers WHERE name = ?').run(name);
    db.prepare('INSERT OR REPLACE INTO server_aliases (old_name, new_name) VALUES (?, ?)').run(name, target.name);
  }
  console.log(`Migration 079: merged local server(s) ${sourceNames.join(', ')} into '${target.name}'`);
  console.warn(`Migration 079: panes started before this still report the old server name(s) (${sourceNames.join(', ')}); the hub resolves them for one release. Re-run \`harness/setup.sh --server-name ${target.name}\` to update the hook configuration.`);
}
