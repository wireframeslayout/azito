import type Database from 'better-sqlite3';

export const version = 78;
export const description = "Normalize misao window rows: mux_ref kind 'misao' and tmux_target '<workspace>:<window id>'";

// Same ULID alphabet as misao's protocol primitives (see @azito/shared mux.ts). Duplicated so the migration keeps
// working whatever the shared helpers become.
const MISAO_WINDOW_ID_RE = /^w_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

interface Row { id: number; server_name: string; tmux_target: string; mux_ref: string | null }
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

/** The misao ref a row stands for, or null when it is not a misao window. */
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

/**
 * A misao window row's `tmux_target` was written in three shapes (`<ws>:<window id>`, `<ws>:<display name>` from the
 * session-wide registration, `<ws>:<ordinal>` from the add-window picker), and a few rows carry a tmux-kind `mux_ref`
 * although their window is a misao id. The display-name and ordinal shapes name another window once windows are
 * renamed or closed and can collide with a tmux window of the same server (UNIQUE(server_name, tmux_target)). Every
 * misao row becomes `mux_ref = {kind:'misao',...}` and `tmux_target = '<workspace>:<window id>'`. A row whose new
 * target or ref is already taken by another row is left as it is and reported.
 */
export function up(db: Database.Database): void {
  const rows = db.prepare('SELECT id, server_name, tmux_target, mux_ref FROM windows').all() as Row[];
  const targetTaken = db.prepare('SELECT 1 FROM windows WHERE server_name = ? AND tmux_target = ? AND id != ?');
  const refTaken = db.prepare('SELECT 1 FROM windows WHERE server_name = ? AND mux_ref = ? AND id != ?');
  const update = db.prepare('UPDATE windows SET tmux_target = ?, mux_ref = ? WHERE id = ?');
  let normalized = 0;
  const skipped: number[] = [];

  for (const row of rows) {
    const ref = misaoRefOf(row);
    if (!ref) continue;
    const target = `${ref.workspace}:${ref.window}`;
    const muxRef = JSON.stringify({ kind: 'misao', workspace: ref.workspace, window: ref.window });
    if (target === row.tmux_target && muxRef === row.mux_ref) continue;
    if (targetTaken.get(row.server_name, target, row.id) || refTaken.get(row.server_name, muxRef, row.id)) {
      skipped.push(row.id);
      continue;
    }
    update.run(target, muxRef, row.id);
    normalized++;
  }

  if (normalized > 0) console.log(`Migration 078: normalized ${normalized} misao window row(s)`);
  if (skipped.length > 0) console.warn(`Migration 078: left misao window row(s) ${skipped.join(', ')} as they are (their normalized target or ref is taken by another row)`);
}
