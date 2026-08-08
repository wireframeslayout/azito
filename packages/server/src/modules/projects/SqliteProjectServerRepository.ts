import type { SqliteDatabase } from '../../shared/db/Database';
import type { ProjectServer, IProjectServerRepository, UpsertProjectServerInput } from './ProjectServer';

interface ProjectServerRow {
  project_id: number;
  server_name: string;
  working_directory: string | null;
  branch: string | null;
  tmux_session: string;
  input_policy: string;
}

const DEFAULT_TMUX_SESSION = 'azito';
const DEFAULT_INPUT_POLICY = 'manual-approval';

export class SqliteProjectServerRepository implements IProjectServerRepository {
  private findByProjectStmt;
  private findByServerStmt;
  private findStmt;
  private upsertStmt;
  private removeStmt;

  constructor(private db: SqliteDatabase) {
    this.findByProjectStmt = db.prepare('SELECT * FROM project_servers WHERE project_id = ?');
    this.findByServerStmt = db.prepare('SELECT * FROM project_servers WHERE server_name = ?');
    this.findStmt = db.prepare('SELECT * FROM project_servers WHERE project_id = ? AND server_name = ?');
    this.upsertStmt = db.prepare(`
      INSERT INTO project_servers (project_id, server_name, working_directory, branch, tmux_session, input_policy)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, server_name)
      DO UPDATE SET working_directory = excluded.working_directory, branch = excluded.branch, tmux_session = excluded.tmux_session, input_policy = excluded.input_policy
    `);
    this.removeStmt = db.prepare('DELETE FROM project_servers WHERE project_id = ? AND server_name = ?');
  }

  findByProject(projectId: number): ProjectServer[] {
    return (this.findByProjectStmt.all(projectId) as ProjectServerRow[]).map(this.toEntity);
  }

  findByServer(serverName: string): ProjectServer[] {
    return (this.findByServerStmt.all(serverName) as ProjectServerRow[]).map(this.toEntity);
  }

  find(projectId: number, serverName: string): ProjectServer | null {
    const row = this.findStmt.get(projectId, serverName) as ProjectServerRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  upsert(data: UpsertProjectServerInput): void {
    this.upsertStmt.run(
      data.projectId,
      data.serverName,
      data.workingDirectory ?? null,
      data.branch ?? null,
      data.tmuxSession,
      data.inputPolicy ?? DEFAULT_INPUT_POLICY,
    );
  }

  remove(projectId: number, serverName: string): void {
    this.removeStmt.run(projectId, serverName);
  }

  private toEntity(row: ProjectServerRow): ProjectServer {
    return {
      projectId: row.project_id,
      serverName: row.server_name,
      workingDirectory: row.working_directory,
      branch: row.branch,
      tmuxSession: row.tmux_session || DEFAULT_TMUX_SESSION,
      inputPolicy: (row.input_policy || DEFAULT_INPUT_POLICY) as 'deny' | 'manual-approval' | 'allow',
    };
  }
}
