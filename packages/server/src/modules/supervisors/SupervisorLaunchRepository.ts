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
  /** Persists a new launch row (status 'pending') with a fresh random launchId + bootstrap secret. */
  create(expectation: SupervisorLaunchExpectation): IssuedSupervisorLaunch;

  findByLaunchId(launchId: string): SupervisorLaunchRow | null;

  findBySessionHash(sessionHash: string): SupervisorLaunchRow | null;

  /** True iff `token` hashes to `row.bootstrapHash` and the row is still `pending` (one-shot). */
  verifyBootstrap(row: Pick<SupervisorLaunchRow, 'bootstrapHash' | 'status'>, token: string): boolean;

  /** True iff `token` hashes to `row.sessionHash`. */
  verifySession(row: Pick<SupervisorLaunchRow, 'sessionHash'>, token: string): boolean;

  /**
   * Consumes the bootstrap secret (moving the row out of `pending`) and mints a fresh session
   * secret for subsequent reconnects. Returns the plaintext session token — never persisted.
   */
  activateWithSession(launchId: string): string;

  /** Marks `last_registered_at = now()` for a reconnect authenticated via the existing session token. */
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

  constructor(private db: SqliteDatabase) {
    this.insertStmt = db.prepare(
      `INSERT INTO supervisor_launches (launch_id, server_name, target, task_id, unit_id, bootstrap_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.findByLaunchIdStmt = db.prepare('SELECT * FROM supervisor_launches WHERE launch_id = ?');
    this.findBySessionHashStmt = db.prepare('SELECT * FROM supervisor_launches WHERE session_hash = ?');
    this.activateStmt = db.prepare(
      "UPDATE supervisor_launches SET status = 'active', session_hash = ?, last_registered_at = datetime('now') WHERE launch_id = ?",
    );
    this.touchStmt = db.prepare("UPDATE supervisor_launches SET last_registered_at = datetime('now') WHERE launch_id = ?");
    this.markStatusStmt = db.prepare('UPDATE supervisor_launches SET status = ? WHERE launch_id = ?');
  }

  create(expectation: SupervisorLaunchExpectation): IssuedSupervisorLaunch {
    const launchId = crypto.randomUUID();
    const bootstrapToken = crypto.randomBytes(32).toString('hex');
    this.insertStmt.run(
      launchId,
      expectation.serverName,
      expectation.target,
      expectation.taskId,
      expectation.unitId,
      hashToken(bootstrapToken),
    );
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

  verifyBootstrap(row: Pick<SupervisorLaunchRow, 'bootstrapHash' | 'status'>, token: string): boolean {
    if (row.status !== 'pending') return false; // one-shot — already consumed
    return timingSafeHashEquals(row.bootstrapHash, token);
  }

  verifySession(row: Pick<SupervisorLaunchRow, 'sessionHash'>, token: string): boolean {
    if (!row.sessionHash) return false;
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
