import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import type { Window, PaneLayout, IWindowRepository } from './Window';
import { isSameWindowTarget } from '@azito/shared';
import { type MuxDriverKind, type MuxRef, formatMuxRef, parseMuxRef, muxRefFromTmuxTarget, tmuxTargetFromMuxRef, isMisaoWindowId } from '@azito/shared';
import { muxWindowTarget } from '../tmux/muxWindowTarget';

/**
 * The `tmux_target` a row stores. A misao window's is always `<workspace>:<window id>` whatever the caller passed (a
 * display name or an ordinal there would collide with — or be mistaken for — a tmux window of the same server).
 */
function storedTarget(tmuxTarget: string, muxRef: MuxRef | undefined): string {
  return muxRef?.kind === 'misao' ? muxWindowTarget(muxRef) : tmuxTarget;
}

/** The mux kind a stored row lives in: its `mux_ref` kind (rows without one are tmux). */
function rowKind(row: Pick<WindowRow, 'mux_ref'>): MuxDriverKind {
  return row.mux_ref ? parseMuxRef(row.mux_ref).kind : 'tmux';
}

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

export interface WindowRow {
  id: number;
  owner_type: string;
  role: Window['role'];
  origin_project_id: number | null;
  project_id: number | null;
  task_id: number | null;
  server_name: string;
  tmux_target: string;
  mux_ref: string | null;
  label: string | null;
  label_source: Window['labelSource'];
  is_primary: number;
  window_type: string;
  worker_type: string | null;
  worker_model: string | null;
  agent_session_id: string | null;
  claude_config_dir: string | null;
  claude_config_dir_explicit: number | null;
  claude_pane_sessions: string | null;
  launch_command: string | null;
  working_directory: string | null;
  pane_layout: string | null;
  sleeping: number;
  created_at: string;
}

export class SqliteWindowRepository implements IWindowRepository {
  private deletionObserver?: (id: number) => void;
  setDeletionObserver(observer: (id: number) => void): void { this.deletionObserver = observer; }

  private addStmt;
  private findAllStmt;
  private findByIdStmt;
  private findByProjectStmt;
  private findByTaskStmt;
  private removeStmt;
  private updatePaneLayoutStmt;
  private findProjectWindowStmt;
  private findByServerStmt;
  private findByServerAndRefStmt;
  private findAgentSessionIdsByServerStmt;
  private nowStmt;
  private updateClaudePrimaryStmt;
  private updateClaudePanesStmt;
  private updateStatements = new Map<string, Statement<unknown[]>>();

  constructor(private db: SqliteDatabase) {
    this.addStmt = db.prepare(`
      INSERT INTO windows (owner_type, role, origin_project_id, project_id, task_id, server_name, tmux_target, mux_ref, label, label_source, is_primary, window_type, worker_type, worker_model, agent_session_id, launch_command, working_directory, pane_layout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    this.findByServerAndRefStmt = db.prepare('SELECT * FROM windows WHERE server_name = ? AND mux_ref = ?');
    this.findAgentSessionIdsByServerStmt = db.prepare(
      'SELECT DISTINCT agent_session_id FROM windows WHERE server_name = ? AND agent_session_id IS NOT NULL',
    );
    this.updateClaudePrimaryStmt = db.prepare('UPDATE windows SET agent_session_id = ?, claude_config_dir = ?, claude_config_dir_explicit = ?, claude_pane_sessions = ? WHERE id = ?');
    this.updateClaudePanesStmt = db.prepare('UPDATE windows SET claude_pane_sessions = ? WHERE id = ?');
    this.nowStmt = db.prepare("SELECT datetime('now') as ts");
  }

  now(): string {
    return (this.nowStmt.get() as { ts: string }).ts;
  }

  add(input: Omit<Window, 'id' | 'createdAt' | 'labelSource'>): number {
    const window = { ...input, tmuxTarget: storedTarget(input.tmuxTarget, input.muxRef) };
    if (window.tmuxTarget && /\.\d+$/.test(window.tmuxTarget)) {
      throw new Error(`tmuxTarget must not contain pane suffix: ${window.tmuxTarget}`);
    }
    if (window.ownerType === 'project') {
      const existing = this.findProjectWindowStmt.get(window.projectId, window.serverName, window.tmuxTarget) as { id: number } | undefined;
      if (existing) {
        if (window.label !== undefined) {
          this.db.prepare("UPDATE windows SET label = ? WHERE id = ? AND label_source = 'auto'")
            .run(window.label, existing.id);
        }
        return existing.id;
      }
    }
    const result = this.addStmt.run(
      window.ownerType,
      window.role,
      window.originProjectId,
      window.projectId,
      window.taskId,
      window.serverName,
      window.tmuxTarget,
      window.muxRef ? formatMuxRef(window.muxRef) : formatMuxRef(muxRefFromTmuxTarget(window.tmuxTarget)),
      window.label,
      'auto',
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
    return rows.map((r) => toWindow(r));
  }

  findOrchestrators(): Window[] {
    return (this.db.prepare("SELECT * FROM windows WHERE role = 'orchestrator'").all() as WindowRow[]).map(r => toWindow(r));
  }

  findById(id: number): Window | undefined {
    const row = this.findByIdStmt.get(id) as WindowRow | undefined;
    return row ? toWindow(row) : undefined;
  }

  findByProject(projectId: number): Window[] {
    const rows = this.findByProjectStmt.all(projectId) as WindowRow[];
    return rows.map((r) => toWindow(r));
  }

  findByTask(taskId: number): Window[] {
    const rows = this.findByTaskStmt.all(taskId) as WindowRow[];
    return rows.map((r) => toWindow(r));
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
      const window = toWindow(row);
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
    return rows.map((r) => toWindow(r));
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
    return toWindow(row);
  }

  findByServerAndRef(serverName: string, ref: MuxRef): Window | undefined {
    const row = this.findByServerAndRefStmt.get(serverName, formatMuxRef(ref)) as WindowRow | undefined;
    return row ? toWindow(row) : undefined;
  }

  findByServerAndSession(serverName: string, sessionName: string, kind: MuxDriverKind): Window[] {
    const rows = this.findByServerStmt.all(serverName) as WindowRow[];
    const prefix = `${sessionName}:`;
    return rows.filter((r) => r.tmux_target.startsWith(prefix) && rowKind(r) === kind).map((r) => toWindow(r));
  }

  adoptForTask(id: number, taskId: number): void {
    this.db.prepare("UPDATE windows SET owner_type = 'task', task_id = ? WHERE id = ?").run(taskId, id);
  }

  renameTmuxWindow(id: number, name: string): void {
    this.db.transaction(() => {
      const row = this.findByIdStmt.get(id) as WindowRow | undefined;
      if (!row || rowKind(row) !== 'tmux') throw new Error('tmux window not found');
      const ref = muxRefFromTmuxTarget(row.tmux_target);
      if (row.owner_type === 'task' && row.is_primary && row.task_id !== null) {
        this.db.prepare("UPDATE tasks SET tmux_window = ?, updated_at = datetime('now') WHERE id = ? AND tmux_window = ?").run(name, row.task_id, ref.window);
      }
      this.update(id, { tmuxTarget: `${ref.workspace}:${name}`, label: name, labelSource: 'user' });
    })();
  }

  update(id: number, data: Partial<Pick<Window,
    'tmuxTarget' | 'muxRef' | 'label' | 'labelSource' | 'agentSessionId' | 'launchCommand' | 'paneLayout' | 'workerModel' | 'workingDirectory' | 'windowType' | 'workerType' | 'sleeping' | 'projectId'
  >>): void {
    this.db.transaction(() => {
    const fields: string[] = [];
    const values: unknown[] = [];


    if (data.projectId !== undefined) { fields.push('project_id = ?'); values.push(data.projectId); }
    if (data.tmuxTarget !== undefined && /\.\d+$/.test(data.tmuxTarget)) {
      throw new Error(`tmuxTarget must not contain pane suffix: ${data.tmuxTarget}`);
    }
    // The target and the ref are kept in step, and a row keeps its mux kind: a target-only update of a misao row
    // re-derives a misao ref (it must name a window id), never a tmux one.
    const muxRef = data.muxRef ?? (data.tmuxTarget !== undefined ? this.refForTargetUpdate(id, data.tmuxTarget) : undefined);
    if (muxRef !== undefined) {
      fields.push('mux_ref = ?'); values.push(formatMuxRef(muxRef));
      const target = muxRef.kind === 'misao' ? muxWindowTarget(muxRef) : (data.tmuxTarget ?? tmuxTargetFromMuxRef(muxRef));
      fields.push('tmux_target = ?'); values.push(target);
    }
    if (data.label !== undefined) { fields.push('label = ?'); values.push(data.label); }
    if (data.labelSource !== undefined) { fields.push('label_source = ?'); values.push(data.labelSource); }
    if (data.agentSessionId !== undefined) {
      this.clearFirstPaneSession(id, data.agentSessionId);
      fields.push("claude_pane_sessions = CASE WHEN agent_session_id IS ? THEN claude_pane_sessions ELSE json_remove(claude_pane_sessions, '$.1') END"); values.push(data.agentSessionId);
      fields.push('claude_config_dir_explicit = CASE WHEN agent_session_id IS ? THEN claude_config_dir_explicit ELSE NULL END'); values.push(data.agentSessionId);
      fields.push('claude_config_dir = CASE WHEN agent_session_id IS ? THEN claude_config_dir ELSE NULL END'); values.push(data.agentSessionId);
      fields.push('agent_session_id = ?'); values.push(data.agentSessionId);
    }
    if (data.launchCommand !== undefined) { fields.push('launch_command = ?'); values.push(data.launchCommand); }
    if (data.paneLayout !== undefined) { fields.push('pane_layout = ?'); values.push(data.paneLayout ? JSON.stringify(data.paneLayout) : null); }
    if (data.workerModel !== undefined) { fields.push('worker_model = ?'); values.push(data.workerModel); }
    if (data.workingDirectory !== undefined) { fields.push('working_directory = ?'); values.push(data.workingDirectory); }
    if (data.windowType !== undefined) { fields.push('window_type = ?'); values.push(data.windowType); }
    if (data.workerType !== undefined) { fields.push('worker_type = ?'); values.push(data.workerType); }
    if (data.sleeping !== undefined) { fields.push('sleeping = ?'); values.push(data.sleeping ? 1 : 0); }

    if (fields.length === 0) return;
    values.push(id);
    const sql = `UPDATE windows SET ${fields.join(', ')} WHERE id = ?`;
    let stmt = this.updateStatements.get(sql);
    if (!stmt) { stmt = this.db.prepare<unknown[]>(sql); this.updateStatements.set(sql, stmt); }
    stmt.run(...values);
    })();
  }

  private refForTargetUpdate(id: number, tmuxTarget: string): MuxRef {
    const row = this.findByIdStmt.get(id) as WindowRow | undefined;
    if (!row || rowKind(row) !== 'misao') return muxRefFromTmuxTarget(tmuxTarget);
    const { workspace, window } = muxRefFromTmuxTarget(tmuxTarget);
    if (!isMisaoWindowId(window)) throw new Error(`A misao window's tmuxTarget must name its window id: ${tmuxTarget}`);
    return { kind: 'misao', workspace, window };
  }

  updateAgentSessionIdByWindow(serverName: string, tmuxTarget: string, sessionId: string): void {
    const rows = this.findByServerStmt.all(serverName) as WindowRow[];
    const ids = rows.filter((r) => isSameWindowTarget(r.tmux_target, tmuxTarget)).map((r) => r.id);
    if (ids.length === 0) return;
    for (const id of ids) this.clearFirstPaneSession(id, sessionId);
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`UPDATE windows SET claude_pane_sessions = CASE WHEN agent_session_id IS ? THEN claude_pane_sessions ELSE json_remove(claude_pane_sessions, '$.1') END, claude_config_dir_explicit = CASE WHEN agent_session_id IS ? THEN claude_config_dir_explicit ELSE NULL END, claude_config_dir = CASE WHEN agent_session_id IS ? THEN claude_config_dir ELSE NULL END, agent_session_id = ? WHERE id IN (${placeholders})`).run(sessionId, sessionId, sessionId, sessionId, ...ids);
  }

  private clearFirstPaneSession(id: number, sessionId: string | null): void {
    const row = this.findByIdStmt.get(id) as WindowRow | undefined;
    if (!row?.pane_layout || row.agent_session_id === sessionId) return;
    const layout = JSON.parse(row.pane_layout) as PaneLayout;
    const panes = layout.panes.map((pane, index) => {
      if (index !== 0) return pane;
      const { agentSessionId: _sessionId, claudeConfigDir: _configDir, claudeConfigDirExplicit: _explicit, ...rest } = pane;
      return { ...rest, ...(sessionId ? { agentSessionId: sessionId } : {}) };
    });
    this.updatePaneLayoutStmt.run(JSON.stringify({ ...layout, panes }), id);
  }

  updateClaudeSessionByPane(serverName: string, tmuxTarget: string, paneOrdinal: number | null, sessionId: string, configDir: string, configDirExplicit: boolean): void {
    this.db.transaction(() => {
    const rows = this.findByServerStmt.all(serverName) as WindowRow[];
    for (const row of rows.filter((r) => isSameWindowTarget(r.tmux_target, tmuxTarget))) {
      const sessions = row.claude_pane_sessions ? JSON.parse(row.claude_pane_sessions) as Record<string, { sessionId: string; configDir: string; configDirExplicit: boolean }> : {};
      if (paneOrdinal !== null) sessions[String(paneOrdinal)] = { sessionId, configDir, configDirExplicit };
      if (row.pane_layout && paneOrdinal !== null) {
        const layout = JSON.parse(row.pane_layout) as PaneLayout;
        const panes = layout.panes.map((pane, index) => (pane.ordinal ?? index + 1) === paneOrdinal
          ? { ...pane, agentSessionId: sessionId, claudeConfigDir: configDir, claudeConfigDirExplicit: configDirExplicit } : pane);
        this.updatePaneLayoutStmt.run(JSON.stringify({ ...layout, panes }), row.id);
      }
      if (paneOrdinal === null || paneOrdinal === 1) {
        this.updateClaudePrimaryStmt.run(sessionId, configDir, configDirExplicit ? 1 : 0, JSON.stringify(sessions), row.id);
      } else {
        this.updateClaudePanesStmt.run(JSON.stringify(sessions), row.id);
      }
    }
    })();
  }

  remove(id: number): void {
    this.deletionObserver?.(id);
    this.removeStmt.run(id);
  }

  removeByServerAndTarget(serverName: string, tmuxTarget: string): number {
    const targetPrefix = tmuxTarget.includes('.') ? tmuxTarget : `${tmuxTarget}.`;
    const rows = this.db.prepare('SELECT id FROM windows WHERE server_name = ? AND (tmux_target = ? OR tmux_target LIKE ?)').all(serverName, tmuxTarget, `${targetPrefix}%`) as Array<{ id: number }>;
    for (const row of rows) this.deletionObserver?.(row.id);
    const result = this.db.prepare(
      'DELETE FROM windows WHERE server_name = ? AND (tmux_target = ? OR tmux_target LIKE ?)',
    ).run(serverName, tmuxTarget, `${targetPrefix}%`);
    return result.changes;
  }

  updatePaneLayout(id: number, layout: PaneLayout): void {
    const row = this.findByIdStmt.get(id) as WindowRow | undefined;
    const sessions = row?.claude_pane_sessions ? JSON.parse(row.claude_pane_sessions) as Record<string, { sessionId: string; configDir: string; configDirExplicit: boolean }> : {};
    const panes = layout.panes.map((pane) => {
      const session = sessions[String(pane.ordinal)];
      if (!session || (pane.agentSessionId && pane.agentSessionId !== session.sessionId)) return pane;
      return { ...pane, agentSessionId: session.sessionId, claudeConfigDir: session.configDir, claudeConfigDirExplicit: session.configDirExplicit };
    });
    this.updatePaneLayoutStmt.run(JSON.stringify({ ...layout, panes }), id);
  }

}

export function toWindow(row: WindowRow): Window {
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
      role: row.role,
      originProjectId: row.origin_project_id,
      projectId: row.project_id,
      taskId: row.task_id,
      serverName: row.server_name,
      tmuxTarget: row.tmux_target,
      muxRef: row.mux_ref ? parseMuxRef(row.mux_ref) : muxRefFromTmuxTarget(row.tmux_target),
      label: row.label,
      labelSource: row.label_source,
      isPrimary: row.is_primary === 1,
      windowType: row.window_type as Window['windowType'],
      workerType: row.worker_type,
      workerModel: row.worker_model,
      agentSessionId: row.agent_session_id,
      claudeConfigDir: row.claude_config_dir,
      claudeConfigDirExplicit: row.claude_config_dir_explicit === null ? null : row.claude_config_dir_explicit === 1,
      claudePaneSessions: row.claude_pane_sessions ? Object.values(JSON.parse(row.claude_pane_sessions) as Record<string, { sessionId: string; configDir: string; configDirExplicit: boolean }>) : [],
      launchCommand: row.launch_command,
      workingDirectory: row.working_directory,
      paneLayout,
      sleeping: row.sleeping === 1,
      createdAt: row.created_at,
    };
  }
