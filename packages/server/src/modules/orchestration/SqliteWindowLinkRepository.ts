import type { Database } from 'better-sqlite3';
import type { WindowLinkView } from './WindowLink';

export type LinkSubject = { windowId: number } | { taskId: number };
export interface LinkRow { id: number; source_window_id: number; target_window_id: number | null; task_id: number | null; kind: 'operation' | 'orchestration'; source: 'manual' | 'auto'; created_at: string; last_interaction_at: string | null; unlinked_at: string | null }

interface Row {
  id: number; source_window_id: number; target_window_id: number | null; task_id: number | null;
  kind: WindowLinkView['kind']; source: WindowLinkView['source']; created_at: string;
  last_interaction_at: string | null; unlinked_at: string | null; resolved_window_id: number | null;
  project_id: number | null; server_name: string | null;
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
    return this.db.prepare(`SELECT l.*, COALESCE(l.target_window_id, primary_window.id) AS resolved_window_id,
      CASE WHEN l.target_window_id IS NOT NULL THEN target.project_id ELSE task.project_id END AS project_id,
      CASE WHEN l.target_window_id IS NOT NULL THEN target.server_name ELSE COALESCE(primary_window.server_name, task.server_name) END AS server_name
      FROM window_links l
      LEFT JOIN windows target ON target.id = l.target_window_id
      LEFT JOIN tasks task ON task.id = l.task_id
      LEFT JOIN windows primary_window ON primary_window.id = (SELECT id FROM windows WHERE owner_type='task' AND task_id=l.task_id AND is_primary=1 ORDER BY created_at ASC, id ASC LIMIT 1)
      WHERE ${where} ORDER BY l.id`).all(...args) as Row[];
  }
  list(source: number, includeUnlinked: boolean, kind?: WindowLinkView['kind']): WindowLinkView[] {
    return this.select(`l.source_window_id=? ${includeUnlinked ? '' : 'AND l.unlinked_at IS NULL'} ${kind ? 'AND l.kind=?' : ''}`, kind ? [source, kind] : [source]).map(r => ({
      id: r.id, sourceWindowId: r.source_window_id, targetWindowId: r.target_window_id, taskId: r.task_id,
      kind: r.kind, source: r.source, createdAt: r.created_at, lastInteractionAt: r.last_interaction_at,
      unlinkedAt: r.unlinked_at, resolvedWindowId: r.resolved_window_id,
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
