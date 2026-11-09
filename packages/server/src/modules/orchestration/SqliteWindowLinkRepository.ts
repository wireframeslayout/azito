import { toWindow, type WindowRow } from '../windows/SqliteWindowRepository';
import type { Database } from 'better-sqlite3';
import type { WindowLinkView } from './WindowLink';

export type LinkSubject = { windowId: number } | { taskId: number };
export interface LinkRow { id: number; source_window_id: number; target_window_id: number | null; task_id: number | null; kind: 'operation' | 'orchestration'; source: 'manual' | 'auto'; created_at: string; last_interaction_at: string | null; unlinked_at: string | null }

interface Row {
  id: number; source_window_id: number; target_window_id: number | null; task_id: number | null;
  kind: WindowLinkView['kind']; source: WindowLinkView['source']; created_at: string;
  last_interaction_at: string | null; unlinked_at: string | null; resolved_window_id: number | null;
  project_id: number | null; server_name: string | null; resolved_task_id: number | null;
  window_worker_type: string | null; window_worker_model: string | null; window_agent_session_id: string | null; window_claude_config_dir: string | null; window_claude_config_dir_explicit: number | null; window_claude_pane_sessions: string | null; window_launch_command: string | null; window_working_directory: string | null; window_pane_layout: string | null; window_created_at: string | null;
  window_owner_type: 'task' | 'project' | 'server' | null;
  window_role: 'orchestrator' | null; window_origin_project_id: number | null; window_project_id: number | null; window_task_id: number | null; window_server_name: string | null; window_tmux_target: string | null; window_mux_ref: string | null; window_label: string | null; window_label_source: 'auto' | 'user' | null; window_is_primary: number | null; window_type: 'terminal' | 'agent' | null; window_sleeping: number | null;
}

export class SqliteWindowLinkRepository {
  constructor(private db: Database) {}
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  affectedSources(kind: 'window' | 'task' | 'project', id: number): number[] {
    const rows = this.db.prepare(`SELECT DISTINCT source_window_id AS id FROM window_links WHERE unlinked_at IS NULL AND (
      (target_window_id IN (SELECT id FROM windows WHERE (?='window' AND id=?) OR (?='task' AND task_id=?) OR (?='project' AND (project_id=? OR task_id IN (SELECT id FROM tasks WHERE project_id=?)))))
      OR (task_id IN (SELECT id FROM tasks WHERE (?='task' AND id=?) OR (?='project' AND project_id=?)))
      OR (source_window_id IN (SELECT id FROM windows WHERE (?='window' AND id=?) OR (?='task' AND task_id=?) OR (?='project' AND (project_id=? OR task_id IN (SELECT id FROM tasks WHERE project_id=?)))))
    )`).all(kind, id, kind, id, kind, id, id, kind, id, kind, id, kind, id, kind, id, kind, id, id) as Array<{ id: number }>;
    return rows.map(row => row.id);
  }
  projectOrigins(id: number): number[] { return (this.db.prepare('SELECT id FROM windows WHERE origin_project_id=?').all(id) as Array<{ id: number }>).map(row => row.id); }
  find(source: number, subject: LinkSubject): LinkRow | undefined {
    return ('windowId' in subject
      ? this.db.prepare('SELECT * FROM window_links WHERE source_window_id=? AND target_window_id=?').get(source, subject.windowId)
      : this.db.prepare('SELECT * FROM window_links WHERE source_window_id=? AND task_id=?').get(source, subject.taskId)) as LinkRow | undefined;
  }
  children(id: number): number[] { return (this.db.prepare("SELECT target_window_id AS id FROM window_links WHERE source_window_id=? AND kind='orchestration' AND unlinked_at IS NULL AND target_window_id IS NOT NULL").all(id) as Array<{ id: number }>).map(row => row.id); }
  parentOf(id: number): number | null { return (this.db.prepare("SELECT source_window_id AS id FROM window_links WHERE target_window_id=? AND kind='orchestration' AND unlinked_at IS NULL LIMIT 1").get(id) as { id: number } | undefined)?.id ?? null; }
  operationParentOf(id: number, exceptSource: number): number | null {
    return (this.db.prepare(`SELECT l.source_window_id AS id FROM window_links l
      JOIN windows source ON source.id=l.source_window_id JOIN windows target ON target.id=l.target_window_id
      WHERE l.target_window_id=? AND l.source_window_id<>? AND l.kind='operation' AND l.unlinked_at IS NULL
      AND source.owner_type='task' AND source.is_primary=1 AND target.owner_type='task' AND target.is_primary=0
      AND source.task_id=target.task_id LIMIT 1`).get(id, exceptSource) as { id: number } | undefined)?.id ?? null;
  }
  operationLinks(taskIds: number[]): Array<{ taskId: number; sourceWindowId: number; targetWindowId: number }> {
    if (taskIds.length === 0) return [];
    return this.db.prepare(`SELECT source.task_id AS taskId, l.source_window_id AS sourceWindowId, l.target_window_id AS targetWindowId
      FROM window_links l JOIN windows source ON source.id=l.source_window_id JOIN windows target ON target.id=l.target_window_id
      WHERE l.kind='operation' AND l.unlinked_at IS NULL AND source.owner_type='task' AND source.is_primary=1
      AND target.owner_type='task' AND target.is_primary=0 AND source.task_id=target.task_id
      AND source.task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds) as Array<{ taskId: number; sourceWindowId: number; targetWindowId: number }>;
  }
  restore(id: number, kind: LinkRow['kind']): void { this.db.prepare("UPDATE window_links SET unlinked_at=NULL, source='manual', kind=? WHERE id=?").run(kind, id); }
  touch(id: number): void { this.db.prepare("UPDATE window_links SET last_interaction_at=datetime('now') WHERE id=?").run(id); }
  insert(sourceWindowId: number, subject: LinkSubject, kind: LinkRow['kind'], source: LinkRow['source']): LinkRow {
    const result = this.db.prepare("INSERT INTO window_links (source_window_id, target_window_id, task_id, kind, source, last_interaction_at) VALUES (?, ?, ?, ?, ?, CASE WHEN ?='auto' THEN datetime('now') ELSE NULL END)").run(sourceWindowId, 'windowId' in subject ? subject.windowId : null, 'taskId' in subject ? subject.taskId : null, kind, source, source);
    return this.db.prepare('SELECT * FROM window_links WHERE id=?').get(result.lastInsertRowid) as LinkRow;
  }
  unlink(source: number, id: number): { targetWindowId: number | null } | undefined {
    const row = this.db.prepare('SELECT target_window_id AS targetWindowId FROM window_links WHERE source_window_id=? AND id=? AND unlinked_at IS NULL').get(source, id) as { targetWindowId: number | null } | undefined;
    if (row) this.db.prepare("UPDATE window_links SET unlinked_at=datetime('now') WHERE source_window_id=? AND id=? AND unlinked_at IS NULL").run(source, id);
    return row;
  }
  private select(where: string, args: unknown[]): Row[] {
    return this.db.prepare(`SELECT l.*, COALESCE(l.target_window_id, primary_window.id) AS resolved_window_id, COALESCE(l.task_id, target.task_id) AS resolved_task_id,
      CASE WHEN l.target_window_id IS NOT NULL THEN target.project_id ELSE task.project_id END AS project_id,
      CASE WHEN l.target_window_id IS NOT NULL THEN target.server_name ELSE COALESCE(primary_window.server_name, task.server_name) END AS server_name
      , resolved.owner_type AS window_owner_type, resolved.role AS window_role, resolved.origin_project_id AS window_origin_project_id,
      resolved.project_id AS window_project_id, resolved.task_id AS window_task_id, resolved.server_name AS window_server_name,
      resolved.tmux_target AS window_tmux_target, resolved.mux_ref AS window_mux_ref, resolved.label AS window_label,
      resolved.label_source AS window_label_source, resolved.is_primary AS window_is_primary, resolved.window_type AS window_type, resolved.sleeping AS window_sleeping,
      resolved.worker_type AS window_worker_type, resolved.worker_model AS window_worker_model, resolved.agent_session_id AS window_agent_session_id,
      resolved.claude_config_dir AS window_claude_config_dir, resolved.claude_config_dir_explicit AS window_claude_config_dir_explicit, resolved.claude_pane_sessions AS window_claude_pane_sessions,
      resolved.launch_command AS window_launch_command, resolved.working_directory AS window_working_directory, resolved.pane_layout AS window_pane_layout, resolved.created_at AS window_created_at
      FROM window_links l
      LEFT JOIN windows target ON target.id = l.target_window_id
      LEFT JOIN tasks task ON task.id = l.task_id
      LEFT JOIN windows primary_window ON primary_window.id = (SELECT id FROM windows WHERE owner_type='task' AND task_id=l.task_id AND is_primary=1 ORDER BY created_at ASC, id ASC LIMIT 1)
      LEFT JOIN windows resolved ON resolved.id=COALESCE(l.target_window_id, primary_window.id)
      WHERE ${where} ORDER BY l.id`).all(...args) as Row[];
  }
  list(source: number, includeUnlinked: boolean, kind?: WindowLinkView['kind']): WindowLinkView[] {
    return this.select(`l.source_window_id=? ${includeUnlinked ? '' : 'AND l.unlinked_at IS NULL'} ${kind ? 'AND l.kind=?' : ''}`, kind ? [source, kind] : [source]).map(r => ({
      id: r.id, sourceWindowId: r.source_window_id, targetWindowId: r.target_window_id, taskId: r.task_id,
      kind: r.kind, source: r.source, createdAt: r.created_at, lastInteractionAt: r.last_interaction_at,
      unlinkedAt: r.unlinked_at, resolvedWindowId: r.resolved_window_id, resolvedTaskId: r.resolved_task_id,
      resolvedWindow: r.window_owner_type === null ? null : linkWindow(toWindow({
        id: r.resolved_window_id, owner_type: r.window_owner_type, role: r.window_role, origin_project_id: r.window_origin_project_id,
        project_id: r.window_project_id, task_id: r.window_task_id, server_name: r.window_server_name, tmux_target: r.window_tmux_target,
        mux_ref: r.window_mux_ref, label: r.window_label, label_source: r.window_label_source, is_primary: r.window_is_primary,
        window_type: r.window_type, sleeping: r.window_sleeping, worker_type: r.window_worker_type, worker_model: r.window_worker_model,
        agent_session_id: r.window_agent_session_id, claude_config_dir: r.window_claude_config_dir, claude_config_dir_explicit: r.window_claude_config_dir_explicit,
        claude_pane_sessions: r.window_claude_pane_sessions, launch_command: r.window_launch_command, working_directory: r.window_working_directory,
        pane_layout: r.window_pane_layout, created_at: r.window_created_at,
      } as WindowRow)),
    }));
  }
  activeForOrchestrators(): Row[] {
    return this.select("l.unlinked_at IS NULL AND l.kind='orchestration' AND EXISTS (SELECT 1 FROM windows source WHERE source.id=l.source_window_id AND source.role='orchestrator')", []);
  }
  incomingSources(id: number): number[] {
    return (this.db.prepare('SELECT DISTINCT source_window_id AS id FROM window_links WHERE target_window_id=? AND unlinked_at IS NULL').all(id) as Array<{ id: number }>).map(r => r.id);
  }
  activeFrom(id: number): Array<{ id: number; targetWindowId: number | null }> {
    return this.db.prepare('SELECT id, target_window_id AS targetWindowId FROM window_links WHERE source_window_id=? AND unlinked_at IS NULL').all(id) as Array<{ id: number; targetWindowId: number | null }>;
  }
}

function linkWindow(window: ReturnType<typeof toWindow>): NonNullable<WindowLinkView['resolvedWindow']> {
  const { id, ownerType, role, originProjectId, projectId, taskId, serverName, tmuxTarget, muxRef, label, labelSource, isPrimary, windowType, sleeping } = window;
  return { id, ownerType, role, originProjectId, projectId, taskId, serverName, tmuxTarget, muxRef, label, labelSource, isPrimary, windowType, sleeping };
}
