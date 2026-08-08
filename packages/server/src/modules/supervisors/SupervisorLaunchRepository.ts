import crypto from 'crypto';
import type { SqliteDatabase } from '../../shared/db/Database';

/** What the hub expects a `register` message to claim, resolved at the moment it wrapped the launch command. */
export interface SupervisorLaunchExpectation {
  serverName: string;
  target: string;
  taskId: number | null;
  unitId: number | null;
}

export type SupervisorLaunchStatus = 'pending' | 'active' | 'replaced' | 'expired';

/**
 * Upper bound on how long an issued-but-never-registered bootstrap token
 * stays valid (Issue #28 third-party review, second round: `markStatus` was
 * never called from production, so a launch that never registered at all —
 * a supervisor process that failed to start, e.g. — stayed `pending` and its
 * bootstrap token kept verifying FOREVER; nothing ever expired it). 15
 * minutes is comfortably longer than any real launch-retry loop (tmux
 * send-keys + process start is on the order of seconds), while still
 * bounding how long a captured/leaked bootstrap token from a launch that
 * never came up stays usable.
 */
export const PENDING_BOOTSTRAP_TTL_MS = 15 * 60 * 1000;

export interface SupervisorLaunchRow extends SupervisorLaunchExpectation {
  id: number;
  launchId: string;
  bootstrapHash: string;
  sessionHash: string | null;
  status: SupervisorLaunchStatus;
  createdAt: string;
  lastRegisteredAt: string | null;
}

/** Returned only at issuance — the bootstrap secret is never persisted or re-derivable, only its sha256. */
export interface IssuedSupervisorLaunch {
  launchId: string;
  bootstrapToken: string;
}

export interface ISupervisorLaunchRepository {
  /**
   * Persists a new launch row (status 'pending') with a fresh random launchId
   * + bootstrap secret. ALSO marks every still-`pending`/`active` prior
   * launch for the SAME `(serverName, target)` as `replaced`, in the same
   * transaction (Issue #28 third-party review, Important finding): without
   * this, issuing a new launch for a key that already has one outstanding
   * left the old launch's session token able to `register()` again later
   * (e.g. after the new supervisor's connection drops) and be treated as
   * `bound` — see `verifySession`'s doc comment for the other half of this
   * fix. A launch is scoped one-to-one to the wrap it was issued for
   * (`SupervisorRegistry.issueLaunch()`, called immediately before a fresh
   * `wrapWithSupervisor()`), so an old one for the same key is by
   * construction obsolete the moment a new one is issued.
   */
  create(expectation: SupervisorLaunchExpectation): IssuedSupervisorLaunch;

  findByLaunchId(launchId: string): SupervisorLaunchRow | null;

  findBySessionHash(sessionHash: string): SupervisorLaunchRow | null;

  /**
   * True iff `token` hashes to `row.bootstrapHash` and the row is still
   * `pending`.
   *
   * NOT one-shot in the sense of "exactly once" (Fix 2, Issue #28
   * third-party review, Important finding): the row stays `pending` — and
   * this keeps succeeding for the SAME bootstrap token — until a session
   * token minted from it actually completes a `register()` round trip (see
   * `touchRegistered`'s doc comment). Without this, a disconnect between the
   * hub minting the session token (`activateWithSession`, which used to flip
   * status straight to `active`) and that `registered` response actually
   * reaching the client left the client holding a bootstrap token that could
   * never verify again (status no longer `pending`) and no usable session
   * token either (it never received it) — that launch's bind was permanently
   * stuck. The one-shot property that matters — a DIFFERENT launch can never
   * reuse this bootstrap — is preserved by `create()`'s supersede step, which
   * marks any outstanding `pending`/`active` row for the same key `replaced`
   * the moment a new launch is issued for it.
   *
   * Bounded by {@link PENDING_BOOTSTRAP_TTL_MS} (Issue #28 third-party
   * review, second round): a launch that never registers at all (the
   * supervisor process failed to start, e.g.) would otherwise stay
   * `pending` -- and its bootstrap token keep verifying -- indefinitely,
   * since nothing else ever transitions it out of `pending`. A row older
   * than the TTL is rejected here even though `status` is still `pending`.
   */
  verifyBootstrap(row: Pick<SupervisorLaunchRow, 'bootstrapHash' | 'status' | 'createdAt'>, token: string): boolean;

  /**
   * True iff `token` hashes to `row.sessionHash` AND the row is `pending` or
   * `active` (Issue #28 third-party review, Important finding: a session
   * hash alone used to be accepted regardless of `status`, so a launch that
   * `create()`'s supersede step — or any other status transition — had since
   * marked `replaced`/`expired` could still authenticate a reconnect with its
   * old session token; `bound: true` is meaningless once the launch it was
   * issued for is no longer the current one for its key). `pending` is
   * included (Fix 2) because a session token can legitimately be used for
   * the FIRST time while the row is still `pending` — see `touchRegistered`.
   */
  verifySession(row: Pick<SupervisorLaunchRow, 'sessionHash' | 'status'>, token: string): boolean;

  /**
   * Verifies the bootstrap secret and (re-)mints a fresh session secret for
   * this launch. Returns the plaintext session token — never persisted.
   *
   * Fix 2: deliberately does NOT change `status` (stays `pending`) — see
   * `verifyBootstrap`'s doc comment. Safe to call more than once for the same
   * launchId (each call overwrites the previous session hash with a new one);
   * only a completed session-token-authenticated `register()` — via
   * `touchRegistered` — actually retires the bootstrap.
   */
  activateWithSession(launchId: string): string;

  /**
   * Marks `last_registered_at = now()` for a reconnect authenticated via the
   * existing session token — AND, if this is the first time a session token
   * for this launch has successfully verified (`status` still `pending`),
   * promotes it to `active` (Fix 2, Issue #28 third-party review, Important
   * finding). This is the actual moment the bootstrap token retires: once
   * `status` is `active`, `verifyBootstrap` above no longer accepts it,
   * closing the retry window that `activateWithSession` deliberately left
   * open. A launch that never completes a session-authenticated round trip
   * (client crashed before reconnecting at all) simply never promotes —
   * still cleaned up by the normal supersede-on-relaunch path.
   */
  touchRegistered(launchId: string): void;

  markStatus(launchId: string, status: SupervisorLaunchStatus): void;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function timingSafeHashEquals(hash: string, token: string): boolean {
  const provided = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(hash, 'hex');
  return stored.length === provided.length && crypto.timingSafeEqual(stored, provided);
}

/**
 * `created_at` is stored via SQLite's `datetime('now')` — `YYYY-MM-DD
 * HH:MM:SS` UTC with no timezone suffix, which `Date` parses as LOCAL time
 * if handed as-is. Appending `Z` (same fix used elsewhere in this codebase
 * for the same SQLite default, e.g. tasks/routes.ts's staleness check)
 * forces UTC interpretation.
 */
function isPendingBootstrapExpired(createdAt: string): boolean {
  const createdAtMs = new Date(createdAt.endsWith('Z') ? createdAt : `${createdAt}Z`).getTime();
  return Date.now() - createdAtMs >= PENDING_BOOTSTRAP_TTL_MS;
}

interface LaunchRawRow {
  id: number;
  launch_id: string;
  server_name: string;
  target: string;
  task_id: number | null;
  unit_id: number | null;
  bootstrap_hash: string;
  session_hash: string | null;
  status: SupervisorLaunchStatus;
  created_at: string;
  last_registered_at: string | null;
}

function toRow(raw: LaunchRawRow): SupervisorLaunchRow {
  return {
    id: raw.id,
    launchId: raw.launch_id,
    serverName: raw.server_name,
    target: raw.target,
    taskId: raw.task_id,
    unitId: raw.unit_id,
    bootstrapHash: raw.bootstrap_hash,
    sessionHash: raw.session_hash,
    status: raw.status,
    createdAt: raw.created_at,
    lastRegisteredAt: raw.last_registered_at,
  };
}

export class SqliteSupervisorLaunchRepository implements ISupervisorLaunchRepository {
  private insertStmt;
  private findByLaunchIdStmt;
  private findBySessionHashStmt;
  private activateStmt;
  private touchStmt;
  private markStatusStmt;
  private supersedeForTargetStmt;

  constructor(private db: SqliteDatabase) {
    this.insertStmt = db.prepare(
      `INSERT INTO supervisor_launches (launch_id, server_name, target, task_id, unit_id, bootstrap_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.findByLaunchIdStmt = db.prepare('SELECT * FROM supervisor_launches WHERE launch_id = ?');
    this.findBySessionHashStmt = db.prepare('SELECT * FROM supervisor_launches WHERE session_hash = ?');
    // Fix 2: no longer touches `status` — see activateWithSession's doc comment on the interface.
    this.activateStmt = db.prepare(
      "UPDATE supervisor_launches SET session_hash = ?, last_registered_at = datetime('now') WHERE launch_id = ?",
    );
    // Fix 2: promotes 'pending' -> 'active' on the first successful session-token register (the CASE
    // is a no-op once already 'active'/'replaced'/'expired') — see touchRegistered's doc comment.
    this.touchStmt = db.prepare(
      `UPDATE supervisor_launches
       SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
           last_registered_at = datetime('now')
       WHERE launch_id = ?`,
    );
    this.markStatusStmt = db.prepare('UPDATE supervisor_launches SET status = ? WHERE launch_id = ?');
    // Every outstanding (pending/active) launch for the SAME key, superseded
    // in the same transaction as the fresh insert below — see create()'s doc
    // comment on ISupervisorLaunchRepository.
    this.supersedeForTargetStmt = db.prepare(
      "UPDATE supervisor_launches SET status = 'replaced' WHERE server_name = ? AND target = ? AND status IN ('pending', 'active')",
    );
  }

  create(expectation: SupervisorLaunchExpectation): IssuedSupervisorLaunch {
    const launchId = crypto.randomUUID();
    const bootstrapToken = crypto.randomBytes(32).toString('hex');
    const run = this.db.transaction((exp: SupervisorLaunchExpectation, id: string, hash: string): void => {
      this.supersedeForTargetStmt.run(exp.serverName, exp.target);
      this.insertStmt.run(id, exp.serverName, exp.target, exp.taskId, exp.unitId, hash);
    });
    run(expectation, launchId, hashToken(bootstrapToken));
    return { launchId, bootstrapToken };
  }

  findByLaunchId(launchId: string): SupervisorLaunchRow | null {
    const row = this.findByLaunchIdStmt.get(launchId) as LaunchRawRow | undefined;
    return row ? toRow(row) : null;
  }

  findBySessionHash(sessionHash: string): SupervisorLaunchRow | null {
    const row = this.findBySessionHashStmt.get(sessionHash) as LaunchRawRow | undefined;
    return row ? toRow(row) : null;
  }

  verifyBootstrap(row: Pick<SupervisorLaunchRow, 'bootstrapHash' | 'status' | 'createdAt'>, token: string): boolean {
    if (row.status !== 'pending') return false; // one-shot — already consumed
    if (isPendingBootstrapExpired(row.createdAt)) return false;
    return timingSafeHashEquals(row.bootstrapHash, token);
  }

  verifySession(row: Pick<SupervisorLaunchRow, 'sessionHash' | 'status'>, token: string): boolean {
    if (!row.sessionHash) return false;
    // Issue #28 third-party review, Important finding: a launch superseded
    // by a newer one for the same (serverName, target) — see create()'s doc
    // comment — must never authenticate again, even with a session token
    // that still hashes correctly. `active` is a currently-live launch;
    // `pending` (Fix 2) is a launch whose session token was minted but has
    // not yet completed its first successful register — both are legitimate,
    // only `replaced`/`expired` are not.
    if (row.status !== 'active' && row.status !== 'pending') return false;
    return timingSafeHashEquals(row.sessionHash, token);
  }

  activateWithSession(launchId: string): string {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    this.activateStmt.run(hashToken(sessionToken), launchId);
    return sessionToken;
  }

  touchRegistered(launchId: string): void {
    this.touchStmt.run(launchId);
  }

  markStatus(launchId: string, status: SupervisorLaunchStatus): void {
    this.markStatusStmt.run(status, launchId);
  }
}

/** sha256-hex helper exported for callers (e.g. SupervisorRegistry) that need to look a session token up by hash. */
export function hashSupervisorToken(token: string): string {
  return hashToken(token);
}
