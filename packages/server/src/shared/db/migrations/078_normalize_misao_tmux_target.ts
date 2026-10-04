import type Database from 'better-sqlite3';

export const version = 78;
export const description = "Normalize misao window rows: mux_ref kind 'misao' and tmux_target '<workspace>:<window id>'";

// Same ULID alphabet as misao's protocol primitives (see @azito/shared mux.ts). Duplicated so the migration keeps
// working whatever the shared helpers become.
const MISAO_WINDOW_ID_RE = /^w_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

interface Row { id: number; server_name: string; tmux_target: string; mux_ref: string | null; task_id: number | null; is_primary: number }
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
 * goes to, so every misao row ends with `mux_ref = {kind:'misao',...}`; its `tmux_target` becomes
 * `<workspace>:<window id>` unless another row holds that target (UNIQUE(server_name, tmux_target)), in which case
 * the old target is kept.
 *
 * Both `tmux_target` and `mux_ref` are UNIQUE per server, so rows naming the same misao window are merged first:
 * - the keeper is a task-bound row when there is one (primary first, then the lowest id), else the lowest id;
 * - rows not bound to a task are deleted, their references (pending operation, watches, supervisor launches) moved to
 *   the keeper;
 * - another task-bound row is kept, kind fixed, when its own ref (its workspace) is not the keeper's; one that would
 *   collide with the keeper's ref cannot be stored with the right kind and is deleted the same way. Both are warned.
 */
export function up(db: Database.Database): void {
  const rows = db.prepare('SELECT id, server_name, tmux_target, mux_ref, task_id, is_primary FROM windows').all() as Row[];
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

  const targetTaken = db.prepare('SELECT 1 FROM windows WHERE server_name = ? AND tmux_target = ? AND id != ?');
  const refHolder = db.prepare('SELECT id, server_name, tmux_target, mux_ref, task_id, is_primary FROM windows WHERE server_name = ? AND mux_ref = ? AND id != ?');
  const update = db.prepare('UPDATE windows SET tmux_target = ?, mux_ref = ? WHERE id = ?');
  const repoint = [
    db.prepare('UPDATE tasks SET pending_operation_window_id = ? WHERE pending_operation_window_id = ?'),
    db.prepare('UPDATE agent_watches SET window_id = ? WHERE window_id = ?'),
    db.prepare('UPDATE supervisor_launches SET window_id = ? WHERE window_id = ?'),
  ];
  const remove = db.prepare('DELETE FROM windows WHERE id = ?');
  const removeInto = (dup: Row, keeper: Row): void => {
    for (const stmt of repoint) stmt.run(keeper.id, dup.id);
    remove.run(dup.id);
  };

  let normalized = 0;
  const merged: number[] = [];
  const warnings: string[] = [];

  for (const group of groups.values()) {
    const taskRows = group.filter((g) => g.row.task_id !== null);
    const candidates = (taskRows.length > 0 ? taskRows : group).slice().sort((a, b) =>
      (b.row.is_primary - a.row.is_primary) || (a.row.id - b.row.id));
    const keeper = candidates[0];
    const keeperRef = refJson(keeper.ref);

    const deferred: Array<{ row: Row; ref: Ref }> = [];
    for (const g of group) {
      if (g === keeper) continue;
      if (g.row.task_id === null) {
        removeInto(g.row, keeper.row);
        merged.push(g.row.id);
      } else if (refJson(g.ref) === keeperRef) {
        removeInto(g.row, keeper.row);
        warnings.push(`row ${g.row.id} (task ${g.row.task_id}) named the same misao window as row ${keeper.row.id} (task ${keeper.row.task_id}) and was merged into it`);
      } else {
        deferred.push(g);
      }
    }

    for (const g of [keeper, ...deferred]) {
      const ref = refJson(g.ref);
      const canonical = targetOf(g.ref);
      const holder = refHolder.get(g.row.server_name, ref, g.row.id) as Row | undefined;
      if (holder) {
        // Another row of this window already holds the ref (two task rows that differed only by kind): the ref can
        // be stored once, so this row is merged into that one rather than left with the wrong kind.
        removeInto(g.row, holder);
        warnings.push(`row ${g.row.id} (task ${g.row.task_id}) named the same misao window as row ${holder.id} (task ${holder.task_id}) and was merged into it`);
        continue;
      }
      const target = targetTaken.get(g.row.server_name, canonical, g.row.id) ? g.row.tmux_target : canonical;
      if (target === g.row.tmux_target && ref === g.row.mux_ref) continue;
      update.run(target, ref, g.row.id);
      normalized++;
      if (target !== canonical) warnings.push(`row ${g.row.id}: kind fixed to misao, tmux_target kept as ${g.row.tmux_target} (${canonical} is taken)`);
      if (g !== keeper) warnings.push(`row ${g.row.id} (task ${g.row.task_id}) is a second task row of misao window ${g.ref.window}; kept with its kind fixed`);
    }
  }

  if (normalized > 0) console.log(`Migration 078: normalized ${normalized} misao window row(s)`);
  if (merged.length > 0) console.log(`Migration 078: merged duplicate misao window row(s) ${merged.join(', ')} (not bound to a task)`);
  for (const warning of warnings) console.warn(`Migration 078: ${warning}`);
}
