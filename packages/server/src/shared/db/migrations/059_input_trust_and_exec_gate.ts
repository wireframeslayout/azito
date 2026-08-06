import type Database from 'better-sqlite3';

export const version = 59;
export const description = 'Add tasks.input_trust + execution approval gate, project_servers.input_policy (Issue #328)';

export function up(db: Database.Database): void {
  // input_trust is the ONLY signal execution gating trusts to tell external
  // (e.g. GitHub/GitLab issue import) input apart from a human-created task —
  // unlike `source`, it is never accepted from a request body (see
  // modules/tasks/routes.ts), so an agent cannot upgrade its own task's trust
  // level. Default 'trusted' preserves current behavior for every existing
  // (manually created) task after this migration runs.
  db.exec(`ALTER TABLE tasks ADD COLUMN input_trust TEXT NOT NULL DEFAULT 'trusted'`);

  // Backfill: rows that came from an external issue tracker via source are
  // the only pre-existing rows that were ever "external" in the sense this
  // gate cares about. `source` itself remains freely editable (used by
  // /azt-link), so this is a one-time historical backfill, not a live rule.
  db.exec(`UPDATE tasks SET input_trust = 'untrusted' WHERE source IN ('github', 'gitlab')`);

  // Records that a human has approved this task's *current resolved
  // execution manifest* (see modules/tasks/execution/ExecutionManifest.ts —
  // the resolved Unit's content, the resolved server's project_servers
  // config, resolved base/target/work branches, task title/description, and
  // resolved subagent config) for autonomous execution while input_trust =
  // 'untrusted'. Compared against a freshly resolved manifest hash at
  // gate-check time (see modules/tasks/execution/ExecutionGate.ts):
  // NULL/mismatch => approval required again. This lets a task run
  // unattended after one approval (Issue #328 "no re-approval on every
  // re-run") while still re-prompting if anything the manifest covers
  // changes underneath the approval — including things that aren't task
  // columns at all, e.g. project.defaultUnitId or the resolved Unit's
  // systemPrompt (Issue #328 fifth-round review: hashing raw task columns
  // missed exactly this class of gap). Named "fingerprint", not
  // "description", because it covers far more than the description field
  // alone (second-round review finding: title changes alone previously
  // bypassed re-approval).
  db.exec(`ALTER TABLE tasks ADD COLUMN execution_approved_fingerprint_hash TEXT`);

  // Per project+server execution policy for untrusted tasks. Default
  // 'manual-approval' is the safe middle ground — new project_servers rows
  // require a human to opt further out (deny) or (once implemented) opt into
  // isolated auto-execution (allow), rather than silently auto-running
  // external input.
  db.exec(`ALTER TABLE project_servers ADD COLUMN input_policy TEXT NOT NULL DEFAULT 'manual-approval'`);

  // Which operation was blocked by the gate and must be resumed (not
  // re-guessed) once a human approves (Issue #328 third-round review): one of
  // 'execute' | 'resume' | 'restore'. Before this column existed, the
  // approval handler in modules/units/routes.ts inferred the operation from
  // whether task.tmuxWindow was set — but TaskRestoreService.restore() also
  // blocks before ever setting tmuxWindow, so that heuristic indistinguishably
  // matched 'restore' and 'execute', and approving a blocked restore ran
  // execute() instead (skipping worktree/window reconstruction and starting
  // an unrequested worker run). NULL means "no pending operation" (the normal
  // case) or, for any row written by this column's own migration before this
  // comment existed, "predates operation tracking" — since 059 has never
  // shipped in a release (no tagged/published version references it; verified
  // against `git tag` and the GitHub releases list), there is no such legacy
  // row to migrate, but the approval handler still falls back to the old
  // tmuxWindow heuristic when this column is NULL, purely as defense in depth
  // rather than a required backfill.
  db.exec(`ALTER TABLE tasks ADD COLUMN pending_operation TEXT`);

  // Which Window row to resume when pending_operation = 'respawn' (Issue
  // #328 fourth-round review finding 2: WindowRespawnService's respawn()/
  // resumeLegacySession() entries used to fall to status='pending_approval'
  // WITHOUT recording pending_operation at all, so approving one of those
  // blocks fell into the tmuxWindow heuristic above and resumed the wrong
  // operation — e.g. approving a blocked respawn silently ran
  // resumeStateMachine() instead of actually respawning the window). NULL
  // for every pending_operation value except 'respawn' — see the write-site
  // catalogue on Task.pendingOperation.
  db.exec(`ALTER TABLE tasks ADD COLUMN pending_operation_window_id INTEGER`);
}
