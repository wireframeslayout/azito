import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Window, PaneLayout, IWindowRepository } from './Window';
import { isSameWindowTarget } from './paneTarget';
import { type MuxRef, formatMuxRef, parseMuxRef, muxRefFromTmuxTarget, tmuxTargetFromMuxRef } from '@azito/shared';

// Re-exported so tmux/routes/sessions.ts (base layer — dependency-cruiser's
// `base-tmux-limited-upward` rule only allow-lists this file, not Window.ts
// itself) can share the exact same primary-window judgment
// WindowRespawnService uses, instead of re-deriving it inline (Issue #28
// third-party review finding — see isPrimaryTaskWindow's own doc comment).
export { isPrimaryTaskWindow } from './Window';
// Re-exported so servers/routes.ts (base layer; only allowed to reach this
// file, not windows/Window.ts directly — see .dependency-cruiser.cjs's
// base-servers-limited-upward exception) can type the isolation_intent
// false->true window-presence check (Issue #29 review, Critical finding 1)
// without importing across the layer boundary.
export type { Window, IWindowRepository } from './Window';

interface WindowRow {
  id: number;
  owner_type: string;
  project_id: number | null;
  task_id: number | null;
  server_name: string;
  tmux_target: string;
  mux_ref: string | null;
  label: string | null;
  is_primary: number;
  window_type: string;
  worker_type: string | null;
  worker_model: string | null;
  agent_session_id: string | null;
  launch_command: string | null;
  working_directory: string | null;
  pane_layout: string | null;
  sleeping: number;
  created_at: string;
}

export class SqliteWindowRepository implements IWindowRepository {
  private addStmt;
  private findAllStmt;
  private findByIdStmt;
  private findByProjectStmt;
  private findByTaskStmt;
  private removeStmt;
  private updatePaneLayoutStmt;
  private findProjectWindowStmt;
  private findByServerStmt;
  private findAgentSessionIdsByServerStmt;
  private nowStmt;

  constructor(private db: SqliteDatabase) {
    this.addStmt = db.prepare(`
      INSERT INTO windows (owner_type, project_id, task_id, server_name, tmux_target, mux_ref, label, is_primary, window_type, worker_type, worker_model, agent_session_id, launch_command, working_directory, pane_layout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findAllStmt = db.prepare('SELECT * FROM windows');
    this.findByIdStmt = db.prepare('SELECT * FROM windows WHERE id = ?');
    this.findByProjectStmt = db.prepare('SELECT * FROM windows WHERE project_id = ? ORDER BY created_at ASC');
    this.findByTaskStmt = db.prepare("SELECT * FROM windows WHERE owner_type = 'task' AND task_id = ? ORDER BY is_primary DESC, created_at ASC");
    this.removeStmt = db.prepare('DELETE FROM windows WHERE id = ?');
    this.updatePaneLayoutStmt = db.prepare('UPDATE windows SET pane_layout = ? WHERE id = ?');
    this.findProjectWindowStmt = db.prepare(
      'SELECT id FROM windows WHERE project_id = ? AND server_name = ? AND tmux_target = ?'
    );
    this.findByServerStmt = db.prepare('SELECT * FROM windows WHERE server_name = ?');
    this.findAgentSessionIdsByServerStmt = db.prepare(
      'SELECT DISTINCT agent_session_id FROM windows WHERE server_name = ? AND agent_session_id IS NOT NULL',
    );
    this.nowStmt = db.prepare("SELECT datetime('now') as ts");
  }

  now(): string {
    return (this.nowStmt.get() as { ts: string }).ts;
  }

  add(window: Omit<Window, 'id' | 'createdAt'>): number {
    if (window.ownerType === 'project') {
      const existing = this.findProjectWindowStmt.get(window.projectId, window.serverName, window.tmuxTarget) as { id: number } | undefined;
      if (existing) {
        if (window.label !== undefined) {
          this.db.prepare('UPDATE windows SET label = ? WHERE id = ?').run(window.label, existing.id);
        }
        return existing.id;
      }
    }
    const result = this.addStmt.run(
      window.ownerType,
      window.projectId,
      window.taskId,
      window.serverName,
      window.tmuxTarget,
      window.muxRef ? formatMuxRef(window.muxRef) : formatMuxRef(muxRefFromTmuxTarget(window.tmuxTarget)),
      window.label,
      window.isPrimary ? 1 : 0,
      window.windowType,
      window.workerType,
      window.workerModel,
      window.agentSessionId,
      window.launchCommand,
      window.workingDirectory,
      window.paneLayout ? JSON.stringify(window.paneLayout) : null,
    );
    return Number(result.lastInsertRowid);
  }

  findAll(): Window[] {
    const rows = this.findAllStmt.all() as WindowRow[];
    return rows.map((r) => this.toWindow(r));
  }

  findById(id: number): Window | undefined {
    const row = this.findByIdStmt.get(id) as WindowRow | undefined;
    return row ? this.toWindow(row) : undefined;
  }

  findByProject(projectId: number): Window[] {
    const rows = this.findByProjectStmt.all(projectId) as WindowRow[];
    return rows.map((r) => this.toWindow(r));
  }

  findByTask(taskId: number): Window[] {
    const rows = this.findByTaskStmt.all(taskId) as WindowRow[];
    return rows.map((r) => this.toWindow(r));
  }

  findByTaskIds(taskIds: number[]): Map<number, Window[]> {
    const byTask = new Map<number, Window[]>();
    if (taskIds.length === 0) return byTask;
    // Prepared per call: the placeholder count varies with the input length, so this
    // cannot use a cached statement the way the single-id lookup above does.
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM windows WHERE owner_type = 'task' AND task_id IN (${placeholders}) ORDER BY is_primary DESC, created_at ASC`)
      .all(...taskIds) as WindowRow[];
    for (const row of rows) {
      const window = this.toWindow(row);
      const taskId = row.task_id as number;
      const existing = byTask.get(taskId);
      if (existing) existing.push(window);
      else byTask.set(taskId, [window]);
    }
    return byTask;
  }

  findAgentSessionIdsByServer(serverName: string): Set<string> {
    const rows = this.findAgentSessionIdsByServerStmt.all(serverName) as { agent_session_id: string }[];
    return new Set(rows.map((r) => r.agent_session_id));
  }

  findByServer(serverName: string): Window[] {
    const rows = this.findByServerStmt.all(serverName) as WindowRow[];
    return rows.map((r) => this.toWindow(r));
  }

  findByServerAndTarget(serverName: string, tmuxTarget: string): Window | undefined {
    // sqlite has no built-in regex, so pane-suffix stripping happens in JS after narrowing to
    // this server (there are never enough windows per server for this to matter perf-wise).
    const rows = this.findByServerStmt.all(serverName) as WindowRow[];
    const matches = rows.filter((r) => isSameWindowTarget(r.tmux_target, tmuxTarget));
    if (matches.length === 0) return undefined;
    // Multiple rows can share a physical target — a project-owned row and a task-owned row can
    // legitimately point at the same tmuxTarget at once. Prefer a task-owning row: it carries
    // runtime info (launchCommand, agentSessionId) that callers like pane-loading-state need.
    // Supervised-or-not is now derived from windowType, so the choice doesn't affect that.
    const row = matches.find((r) => r.task_id !== null) ?? matches[0];
    return this.toWindow(row);
  }

  findByServerAndRef(serverName: string, ref: MuxRef): Window | undefined {
    const row = this.db.prepare('SELECT * FROM windows WHERE server_name = ? AND mux_ref = ?').get(serverName, formatMuxRef(ref)) as WindowRow | undefined;
    return row ? this.toWindow(row) : undefined;
  }

  findByServerAndSession(serverName: string, sessionName: string): Window[] {
    const rows = this.findByServerStmt.all(serverName) as WindowRow[];
    const prefix = `${sessionName}:`;
    return rows.filter((r) => r.tmux_target.startsWith(prefix)).map((r) => this.toWindow(r));
  }

  update(id: number, data: Partial<Pick<Window,
    'tmuxTarget' | 'muxRef' | 'label' | 'agentSessionId' | 'launchCommand' | 'paneLayout' | 'workerModel' | 'workingDirectory' | 'windowType' | 'workerType' | 'sleeping' | 'projectId'
  >>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.projectId !== undefined) { fields.push('project_id = ?'); values.push(data.projectId); }
    if (data.tmuxTarget !== undefined) {
      fields.push('tmux_target = ?'); values.push(data.tmuxTarget);
      if (!data.muxRef) { fields.push('mux_ref = ?'); values.push(formatMuxRef(muxRefFromTmuxTarget(data.tmuxTarget))); }
    }
    if (data.muxRef !== undefined) {
      fields.push('mux_ref = ?'); values.push(formatMuxRef(data.muxRef));
      if (!data.tmuxTarget) { fields.push('tmux_target = ?'); values.push(tmuxTargetFromMuxRef(data.muxRef)); }
    }
    if (data.label !== undefined) { fields.push('label = ?'); values.push(data.label); }
    if (data.agentSessionId !== undefined) { fields.push('agent_session_id = ?'); values.push(data.agentSessionId); }
    if (data.launchCommand !== undefined) { fields.push('launch_command = ?'); values.push(data.launchCommand); }
    if (data.paneLayout !== undefined) { fields.push('pane_layout = ?'); values.push(data.paneLayout ? JSON.stringify(data.paneLayout) : null); }
    if (data.workerModel !== undefined) { fields.push('worker_model = ?'); values.push(data.workerModel); }
    if (data.workingDirectory !== undefined) { fields.push('working_directory = ?'); values.push(data.workingDirectory); }
    if (data.windowType !== undefined) { fields.push('window_type = ?'); values.push(data.windowType); }
    if (data.workerType !== undefined) { fields.push('worker_type = ?'); values.push(data.workerType); }
    if (data.sleeping !== undefined) { fields.push('sleeping = ?'); values.push(data.sleeping ? 1 : 0); }

    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE windows SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  updateAgentSessionIdByWindow(serverName: string, tmuxTarget: string, sessionId: string): void {
    const rows = this.findByServerStmt.all(serverName) as WindowRow[];
    const ids = rows.filter((r) => isSameWindowTarget(r.tmux_target, tmuxTarget)).map((r) => r.id);
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`UPDATE windows SET agent_session_id = ? WHERE id IN (${placeholders})`).run(sessionId, ...ids);
  }

  remove(id: number): void {
    this.removeStmt.run(id);
  }

  removeByServerAndTarget(serverName: string, tmuxTarget: string): number {
    const targetPrefix = tmuxTarget.includes('.') ? tmuxTarget : `${tmuxTarget}.`;
    const result = this.db.prepare(
      'DELETE FROM windows WHERE server_name = ? AND (tmux_target = ? OR tmux_target LIKE ?)',
    ).run(serverName, tmuxTarget, `${targetPrefix}%`);
    return result.changes;
  }

  updatePaneLayout(id: number, layout: PaneLayout): void {
    this.updatePaneLayoutStmt.run(JSON.stringify(layout), id);
  }

  private toWindow(row: WindowRow): Window {
    let paneLayout: PaneLayout | null = null;
    if (row.pane_layout) {
      try {
        paneLayout = JSON.parse(row.pane_layout) as PaneLayout;
      } catch {
        paneLayout = null;
      }
    }

    return {
      id: row.id,
      ownerType: row.owner_type as Window['ownerType'],
      projectId: row.project_id,
      taskId: row.task_id,
      serverName: row.server_name,
      tmuxTarget: row.tmux_target,
      muxRef: row.mux_ref ? parseMuxRef(row.mux_ref) : muxRefFromTmuxTarget(row.tmux_target),
      label: row.label,
      isPrimary: row.is_primary === 1,
      windowType: row.window_type as Window['windowType'],
      workerType: row.worker_type,
      workerModel: row.worker_model,
      agentSessionId: row.agent_session_id,
      launchCommand: row.launch_command,
      workingDirectory: row.working_directory,
      paneLayout,
      sleeping: row.sleeping === 1,
      createdAt: row.created_at,
    };
  }
}
