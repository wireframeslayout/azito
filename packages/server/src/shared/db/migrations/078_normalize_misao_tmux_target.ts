import type Database from 'better-sqlite3';

export const version = 78;
export const description = "Normalize misao window rows: mux_ref kind 'misao' and tmux_target '<workspace>:<window id>'";

// Same ULID alphabet as misao's protocol primitives (see @azito/shared mux.ts). Duplicated so the migration keeps
// working whatever the shared helpers become.
const MISAO_WINDOW_ID_RE = /^w_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

interface Row {
  id: number; server_name: string; tmux_target: string; mux_ref: string | null; task_id: number | null; is_primary: number;
  project_id: number | null; label: string | null; sleeping: number;
}
interface Ref { kind: string; workspace: string; window: string }

function parseRef(json: string | null): Ref | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<Ref>;
    return typeof parsed.kind === 'string' && typeof parsed.workspace === 'string' && typeof parsed.window === 'string'
      ? { kind: parsed.kind, workspace: parsed.workspace, window: parsed.window }
      : null;
  } catch {
    return null;
  }
}

/** The misao window a row stands for (workspace + window id), or null when it is not a misao window. */
function misaoRefOf(row: Row): Ref | null {
  const ref = parseRef(row.mux_ref);
  if (ref?.kind === 'misao') return ref;
  // A row stored with a tmux-kind ref (or none) whose window is a misao window id: written by a name-based path.
  if (ref && ref.kind === 'tmux' && MISAO_WINDOW_ID_RE.test(ref.window)) return { kind: 'misao', workspace: ref.workspace, window: ref.window };
  if (!ref) {
    const sep = row.tmux_target.indexOf(':');
    const window = sep === -1 ? '' : row.tmux_target.slice(sep + 1);
    if (MISAO_WINDOW_ID_RE.test(window)) return { kind: 'misao', workspace: row.tmux_target.slice(0, sep), window };
  }
  return null;
}

const refJson = (ref: Ref): string => JSON.stringify({ kind: 'misao', workspace: ref.workspace, window: ref.window });
const targetOf = (ref: Ref): string => `${ref.workspace}:${ref.window}`;

/**
 * A misao window row's `tmux_target` was written in three shapes (`<ws>:<window id>`, `<ws>:<display name>` from the
 * session-wide registration, `<ws>:<ordinal>` from the add-window picker), and a few rows carry a tmux-kind `mux_ref`
 * although their window is a misao id. A row's `mux_ref` kind decides which driver every operation on the window
 * goes to, so every misao row ends with `mux_ref = {kind:'misao',...}` and, when that target is free,
 * `tmux_target = <workspace>:<window id>` (otherwise the old target is kept: UNIQUE(server_name, tmux_target)).
 *
 * misao addresses a window by its id alone (the workspace is not part of its identity), so the rows naming one misao
 * window on a server — whatever workspace they carry — are merged into one, as 068 did for tmux windows:
 * - the keeper is the task row of the latest task (largest task id); without task rows, the primary / lowest-id row;
 * - the keeper takes over `project_id` / `label` (COALESCE) and `sleeping` (MAX) of the merged rows;
 * - references to a merged row move to the keeper only when they belong to the keeper's task (a pending operation, a
 *   supervisor launch) or to the window itself (an agent watch); another task's reference is cleared, and that task
 *   is reported. The migration never fails on such data;
 * - a supervisor launch is found again by `(server_name, target)` when it is expired, so one of the keeper's task stays
 *   on the keeper only when its target is the keeper's final `tmux_target`; a live (pending/active) one that does not
 *   match is detached and expired (it could not be expired later). The keeper's own launches follow the same rule.
 */
export function up(db: Database.Database): void {
  const rows = db.prepare('SELECT id, server_name, tmux_target, mux_ref, task_id, is_primary, project_id, label, sleeping FROM windows').all() as Row[];
  const groups = new Map<string, Array<{ row: Row; ref: Ref }>>();
  for (const row of rows) {
    const ref = misaoRefOf(row);
    if (!ref) continue;
    const key = `${row.server_name}\u0000${ref.window}`;
    const group = groups.get(key) ?? [];
    group.push({ row, ref });
    groups.set(key, group);
  }
  if (groups.size === 0) return;

  const update = db.prepare('UPDATE windows SET tmux_target = ?, mux_ref = ? WHERE id = ?');
  const inherit = db.prepare('UPDATE windows SET project_id = COALESCE(project_id, ?), label = COALESCE(label, ?), sleeping = MAX(sleeping, ?) WHERE id = ?');
  const pendingOf = db.prepare('SELECT id FROM tasks WHERE pending_operation_window_id = ?');
  const setPending = db.prepare('UPDATE tasks SET pending_operation_window_id = ? WHERE id = ?');
  const launchesOf = db.prepare('SELECT id, task_id, target, status FROM supervisor_launches WHERE window_id = ?');
  const setLaunch = db.prepare('UPDATE supervisor_launches SET window_id = ? WHERE id = ?');
  const expireLaunch = db.prepare("UPDATE supervisor_launches SET window_id = NULL, status = 'expired' WHERE id = ?");
  const targetHolder = db.prepare('SELECT id FROM windows WHERE server_name = ? AND tmux_target = ? AND id != ?');
  const moveWatches = db.prepare('UPDATE agent_watches SET window_id = ? WHERE window_id = ?');
  const remove = db.prepare('DELETE FROM windows WHERE id = ?');

  let normalized = 0;
  const merged: number[] = [];
  const detachedTasks = new Set<number>();

  interface Launch { id: number; task_id: number | null; target: string; status: string }
  const isLive = (launch: Launch): boolean => launch.status === 'pending' || launch.status === 'active';
  /** A launch of the keeper's task: kept on the keeper when its target is the keeper's final one, else expired when live. */
  const settleOwnLaunch = (launch: Launch, keeper: Row, finalTarget: string): void => {
    if (launch.target === finalTarget) setLaunch.run(keeper.id, launch.id);
    else if (isLive(launch)) expireLaunch.run(launch.id);
    else setLaunch.run(null, launch.id);
  };

  const mergeInto = (dup: Row, keeper: Row, finalTarget: string): void => {
    inherit.run(dup.project_id, dup.label, dup.sleeping, keeper.id);
    for (const { id: taskId } of pendingOf.all(dup.id) as Array<{ id: number }>) {
      const own = keeper.task_id !== null && taskId === keeper.task_id;
      setPending.run(own ? keeper.id : null, taskId);
      if (!own) detachedTasks.add(taskId);
    }
    for (const launch of launchesOf.all(dup.id) as Launch[]) {
      const own = keeper.task_id !== null && launch.task_id === keeper.task_id;
      if (own) {
        settleOwnLaunch(launch, keeper, finalTarget);
      } else {
        setLaunch.run(null, launch.id);
        if (launch.task_id !== null) detachedTasks.add(launch.task_id);
      }
    }
    // A watch follows the physical window, whichever row stood for it.
    moveWatches.run(keeper.id, dup.id);
    remove.run(dup.id);
    merged.push(dup.id);
  };

  for (const group of groups.values()) {
    const taskRows = group.filter((g) => g.row.task_id !== null);
    const keeper = taskRows.length > 0
      ? taskRows.slice().sort((a, b) => (b.row.task_id! - a.row.task_id!) || (b.row.is_primary - a.row.is_primary) || (a.row.id - b.row.id))[0]
      : group.slice().sort((a, b) => (b.row.is_primary - a.row.is_primary) || (a.row.id - b.row.id))[0];
    // The keeper's final target first: the window-id form unless a row outside this group holds it (rows of the group
    // are merged away below, freeing it). Launches are settled against it.
    const ref = refJson(keeper.ref);
    const canonical = targetOf(keeper.ref);
    const groupIds = new Set(group.map((g) => g.row.id));
    const holder = targetHolder.get(keeper.row.server_name, canonical, keeper.row.id) as { id: number } | undefined;
    const target = holder && !groupIds.has(holder.id) ? keeper.row.tmux_target : canonical;

    for (const g of group) if (g !== keeper) mergeInto(g.row, keeper.row, target);
    if (target !== keeper.row.tmux_target) {
      for (const launch of launchesOf.all(keeper.row.id) as Launch[]) settleOwnLaunch(launch, keeper.row, target);
    }

    if (target === keeper.row.tmux_target && ref === keeper.row.mux_ref) continue;
    update.run(target, ref, keeper.row.id);
    normalized++;
    if (target !== canonical) console.warn(`Migration 078: row ${keeper.row.id}: kind fixed to misao, tmux_target kept as ${target} (${canonical} is taken)`);
  }

  if (normalized > 0) console.log(`Migration 078: normalized ${normalized} misao window row(s)`);
  if (merged.length > 0) console.log(`Migration 078: merged duplicate misao window row(s) ${merged.join(', ')}`);
  if (detachedTasks.size > 0) {
    console.warn(`Migration 078: task(s) ${[...detachedTasks].join(', ')} pointed at a merged misao window row of another task; those references were cleared`);
  }
}
