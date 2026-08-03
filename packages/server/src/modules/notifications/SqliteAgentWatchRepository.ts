import type { SqliteDatabase } from '../../shared/db/Database';

export interface AgentWatchRecord {
  id: number;
  endpoint: string;
  serverName: string;
  target: string;
  label: string | null;
  createdAt: string;
}

interface AgentWatchRow {
  id: number;
  endpoint: string;
  server_name: string;
  target: string;
  label: string | null;
  created_at: string;
}

export class SqliteAgentWatchRepository {
  private upsertStmt;
  private removeByKeyStmt;
  private findByKeyStmt;
  private findByEndpointStmt;
  private deleteByIdStmt;

  constructor(private db: SqliteDatabase) {
    this.upsertStmt = db.prepare(`
      INSERT INTO agent_watches (endpoint, server_name, target, label)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint, server_name, target) DO UPDATE SET label = excluded.label
    `);
    this.removeByKeyStmt = db.prepare(
      'DELETE FROM agent_watches WHERE endpoint = ? AND server_name = ? AND target = ?',
    );
    this.findByKeyStmt = db.prepare(
      'SELECT * FROM agent_watches WHERE server_name = ? AND target = ? ORDER BY created_at',
    );
    this.findByEndpointStmt = db.prepare(
      'SELECT * FROM agent_watches WHERE endpoint = ? ORDER BY created_at',
    );
    this.deleteByIdStmt = db.prepare('DELETE FROM agent_watches WHERE id = ?');
  }

  add(endpoint: string, serverName: string, target: string, label: string | null): void {
    this.upsertStmt.run(endpoint, serverName, target, label);
  }

  removeByKey(endpoint: string, serverName: string, target: string): void {
    this.removeByKeyStmt.run(endpoint, serverName, target);
  }

  findByKey(serverName: string, target: string): AgentWatchRecord[] {
    return (this.findByKeyStmt.all(serverName, target) as AgentWatchRow[]).map((r) => this.toEntity(r));
  }

  findByEndpoint(endpoint: string): AgentWatchRecord[] {
    return (this.findByEndpointStmt.all(endpoint) as AgentWatchRow[]).map((r) => this.toEntity(r));
  }

  deleteById(id: number): void {
    this.deleteByIdStmt.run(id);
  }

  private toEntity(row: AgentWatchRow): AgentWatchRecord {
    return {
      id: row.id,
      endpoint: row.endpoint,
      serverName: row.server_name,
      target: row.target,
      label: row.label,
      createdAt: row.created_at,
    };
  }
}
