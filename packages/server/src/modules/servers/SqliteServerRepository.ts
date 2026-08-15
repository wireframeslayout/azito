import type { SqliteDatabase } from '../../shared/db/Database';
import { seal, open } from '../../shared/crypto/SecretBox';
import type { ServerConfig, IServerRepository, MuxRuntime } from './Server';

const COLUMNS = 'name, type, host, agent_port, agent_token, agent_version, ssh_host, mux_runtime, ssh_host_fingerprint, isolation_intent, isolation_verified_at, isolation_report, created_at';

export class SqliteServerRepository implements IServerRepository {
  private listStmt;
  private getStmt;
  private addStmt;
  private removeStmt;
  private updateStmt;
  private updateAgentVersionStmt;
  private updateFingerprintStmt;
  private clearFingerprintStmt;
  private updateIsolationIntentStmt;
  private updateIsolationReportStmt;

  constructor(private db: SqliteDatabase) {
    this.listStmt = db.prepare(`SELECT ${COLUMNS} FROM servers WHERE type IN ('local', 'agent') ORDER BY created_at`);
    this.getStmt = db.prepare(`SELECT ${COLUMNS} FROM servers WHERE name = ? AND type IN ('local', 'agent')`);
    this.addStmt = db.prepare('INSERT INTO servers (name, type, host, agent_port, agent_token, agent_version, ssh_host, mux_runtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.removeStmt = db.prepare('DELETE FROM servers WHERE name = ?');
    this.updateStmt = db.prepare('UPDATE servers SET type = ?, host = ?, agent_port = ?, agent_token = ?, ssh_host = ?, mux_runtime = ? WHERE name = ?');
    this.updateAgentVersionStmt = db.prepare('UPDATE servers SET agent_version = ? WHERE name = ?');
    this.updateFingerprintStmt = db.prepare('UPDATE servers SET ssh_host_fingerprint = ? WHERE name = ?');
    this.clearFingerprintStmt = db.prepare('UPDATE servers SET ssh_host_fingerprint = NULL WHERE name = ?');
    this.updateIsolationIntentStmt = db.prepare('UPDATE servers SET isolation_intent = ? WHERE name = ?');
    this.updateIsolationReportStmt = db.prepare('UPDATE servers SET isolation_report = ? WHERE name = ?');
  }

  findAll(): ServerConfig[] {
    const rows = this.listStmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.toEntity(r));
  }

  findByName(name: string): ServerConfig | null {
    const row = this.getStmt.get(name) as Record<string, unknown> | undefined;
    return row ? this.toEntity(row) : null;
  }

  create(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, agentVersion?: string, sshHost?: string, muxRuntime?: MuxRuntime): void {
    this.addStmt.run(name, type, host ?? null, agentPort ?? null, seal(agentToken ?? null), agentVersion ?? null, sshHost ?? null, muxRuntime ?? 'system');
  }

  update(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, sshHost?: string, muxRuntime?: MuxRuntime): void {
    this.updateStmt.run(type, host ?? null, agentPort ?? null, seal(agentToken ?? null), sshHost ?? null, muxRuntime ?? 'system', name);
  }

  updateAgentVersion(name: string, version: string): void {
    this.updateAgentVersionStmt.run(version, name);
  }

  updateFingerprint(name: string, fingerprint: string): void {
    this.updateFingerprintStmt.run(fingerprint, name);
  }

  clearFingerprint(name: string): void {
    this.clearFingerprintStmt.run(name);
  }

  updateIsolationIntent(name: string, isolationIntent: boolean): void {
    this.updateIsolationIntentStmt.run(isolationIntent ? 1 : 0, name);
  }

  updateIsolationReport(name: string, report: string | null): void {
    this.updateIsolationReportStmt.run(report, name);
  }

  delete(name: string): void {
    this.removeStmt.run(name);
  }

  private toEntity(row: Record<string, unknown>): ServerConfig {
    return {
      name: row.name as string,
      type: row.type as ServerConfig['type'],
      host: (row.host as string) ?? null,
      agentPort: (row.agent_port as number) ?? null,
      agentToken: open(row.agent_token as string | null),
      agentVersion: (row.agent_version as string) ?? null,
      sshHost: (row.ssh_host as string) ?? null,
      muxRuntime: (row.mux_runtime as MuxRuntime) ?? 'system',
      sshHostFingerprint: (row.ssh_host_fingerprint as string) ?? null,
      isolationIntent: (row.isolation_intent as number) === 1,
      isolationVerifiedAt: (row.isolation_verified_at as string) ?? null,
      isolationReport: (row.isolation_report as string) ?? null,
      createdAt: row.created_at as string,
    };
  }
}
