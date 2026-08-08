import type Database from 'better-sqlite3';

export const version = 60;
export const description = 'task_tokens capability table + audit_log + task origination columns (Issue #28 Phase A)';

export function up(db: Database.Database): void {
  // Capability row per issued task token (design v3 §2). Plaintext is never
  // stored — only sha256(secret). No column is added to `tasks` for this
  // (design v3 §2: "tasks への列追加はしない（履歴を null 化で消さない）"), so
  // a task's token history survives independently of the task row's own
  // lifecycle; `task_id` intentionally has no FOREIGN KEY (with cascade or
  // without) so that DELETE FROM tasks never needs a matching cascade rule —
  // SqliteTaskRepository.delete()/updateStatus() explicitly revoke (not
  // delete) matching rows in the same transaction before/around the tasks
  // write (see that file's revocation comment).
  db.exec(`
    CREATE TABLE task_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      window_generation INTEGER NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      revoke_reason TEXT
    )
  `);
  db.exec('CREATE INDEX idx_task_tokens_task_id ON task_tokens(task_id)');
  // A token hash must uniquely identify at most one row — guards against a
  // secret collision (astronomically unlikely with 32 random bytes, but
  // cheap to enforce) ever verifying against the wrong task.
  db.exec('CREATE UNIQUE INDEX idx_task_tokens_hash ON task_tokens(token_hash)');

  // Operational audit trail (design v3 §10). Not tamper-evident — see the
  // doc comment on shared/audit/AuditLogRepository.ts. `detail` is a JSON
  // blob and must never carry Authorization headers, request bodies, secret
  // values, or turnToken (callers redact before calling record()).
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      actor_class TEXT NOT NULL,
      actor_id INTEGER,
      event TEXT NOT NULL,
      detail TEXT
    )
  `);
  db.exec('CREATE INDEX idx_audit_log_ts ON audit_log(ts)');

  // Origination columns (Issue #28 Phase A後半, TaskOriginationService —
  // design v3 §5). Extending this still-unreleased migration directly
  // rather than adding a new one (per AGENTS.md instructions for this
  // phase): 060 has never shipped, so there is no deployed schema to
  // migrate forward from.
  //
  // `created_by_kind` defaults to 'operator' with a NOT NULL backfill for
  // every existing row (design v3 §5: "既存行のバックフィルは 'operator' /
  // null") — every task in the table before this column existed was, in
  // fact, created through the pre-Phase-A `POST /api/tasks`/`import-issue`
  // handlers, which only ever ran as an authenticated operator (no task
  // principal existed yet to create anything). `created_by_id` has no
  // matching backfill value (no historical row recorded which task/trigger
  // originated it, because nothing but 'operator' could originate one) and
  // stays NULL, matching 'operator''s own "no single subject" semantics
  // (see Task.ts's `createdById` doc comment).
  db.exec("ALTER TABLE tasks ADD COLUMN created_by_kind TEXT NOT NULL DEFAULT 'operator'");
  db.exec('ALTER TABLE tasks ADD COLUMN created_by_id INTEGER');

  // Extending this still-unreleased migration further, same rationale as the
  // origination columns' own comment above (Issue #28 third-party review
  // fix): POST /api/tasks/:id/children's per-parent rate limit originally
  // counted a parent's ENTIRE lifetime child count, so a parent that ever
  // crossed N=20 across several follow-up runs could never spawn another
  // child again — not "N=20 per execution run" as intended. Nullable, no
  // backfill needed (no historical row could have had a generation to
  // record before this column existed). See Task.ts's `createdViaGeneration`
  // doc comment for the full contract.
  db.exec('ALTER TABLE tasks ADD COLUMN created_via_generation INTEGER');

  // Composite index (Issue #28 third-party review, Minor finding) backing
  // the two children-count queries above (SqliteTaskRepository.ts's
  // countChildren-style lookups): `WHERE created_by_kind = 'task' AND
  // created_by_id = ?` and the same predicate plus `created_via_generation =
  // ?`. Column order matches both queries' equality predicates so a single
  // index serves each (the generation-scoped query is a prefix match on the
  // lifetime-scoped one's columns).
  db.exec('CREATE INDEX idx_tasks_created_by ON tasks(created_by_kind, created_by_id, created_via_generation)');

  // Extending this still-unreleased migration a third time (same rationale
  // as the two comments above — 060 has never shipped). Issue #28 Phase C
  // (design v3 §8): persists one row per `tui-supervisor` launch so a
  // `register` message's claimed identity (serverName/target/taskId/unitId)
  // can be checked against what the hub itself expected when it wrapped the
  // launch command with `--launch-id`/`--bootstrap-token`
  // (SupervisorLaunch.ts's wrapWithSupervisor), surviving a hub restart.
  //
  // `bootstrap_hash` / `session_hash` store only sha256 of the respective
  // secret (same "plaintext never stored" rule as task_tokens.token_hash
  // above) — `bootstrap_hash` authenticates the FIRST register (one-shot:
  // the service layer only accepts it while `status = 'pending'`);
  // `session_hash` is minted on that first successful register and
  // authenticates every reconnect after (process restarts of the same
  // launch, network blips) without re-spending the bootstrap secret.
  //
  // `status` (`pending` | `active` | `replaced` | `expired`) records the
  // launch's lifecycle for audit/debugging; the authoritative "is this
  // launch still current" check is always a fresh column read, never cached.
  //
  // `task_id`/`unit_id` intentionally have no FOREIGN KEY, mirroring
  // `task_tokens.task_id` above (same "no cascade rule to keep in sync with
  // deletes" reasoning) — a launch row is a point-in-time record of what the
  // hub expected to see register, not a live reference.
  db.exec(`
    CREATE TABLE supervisor_launches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      launch_id TEXT NOT NULL,
      server_name TEXT NOT NULL,
      target TEXT NOT NULL,
      task_id INTEGER,
      unit_id INTEGER,
      bootstrap_hash TEXT NOT NULL,
      session_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_registered_at TEXT
    )
  `);
  db.exec('CREATE UNIQUE INDEX idx_supervisor_launches_launch_id ON supervisor_launches(launch_id)');
  db.exec('CREATE UNIQUE INDEX idx_supervisor_launches_session_hash ON supervisor_launches(session_hash)');
}
