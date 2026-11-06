import type { Database } from 'better-sqlite3';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { IWindowRepository, Window } from '../windows/Window';
import type { ITaskRepository } from '../tasks/Task';

type Subject = { windowId: number } | { taskId: number };
type Rejection = 'not_linkable' | 'self_link' | 'already_nested' | 'cycle' | 'not_found';
interface LinkRow { id: number; source_window_id: number; target_window_id: number | null; task_id: number | null; kind: 'operation' | 'orchestration'; source: 'manual' | 'auto'; created_at: string; last_interaction_at: string | null; unlinked_at: string | null }

export class OrchestrationLinkService {
  private lastWrites = new Map<number, number>();
  constructor(private db: Database, private windows: IWindowRepository, private tasks: ITaskRepository, private bus: NotificationBus) {}

  private pruneWrites(now: number): void {
    for (const [key, time] of this.lastWrites) if (now - time >= 5000) this.lastWrites.delete(key);
  }
  private notify(windowId: number): void { this.bus.emit({ type: 'orchestration:updated', payload: { windowId } }); }
  notifyDeletion(kind: 'window' | 'task' | 'project', id: number): void {
    const rows = this.db.prepare(`SELECT DISTINCT source_window_id AS id FROM window_links WHERE unlinked_at IS NULL AND (
      (target_window_id IN (SELECT id FROM windows WHERE (?='window' AND id=?) OR (?='task' AND task_id=?) OR (?='project' AND (project_id=? OR task_id IN (SELECT id FROM tasks WHERE project_id=?)))))
      OR (task_id IN (SELECT id FROM tasks WHERE (?='task' AND id=?) OR (?='project' AND project_id=?)))
      OR (source_window_id IN (SELECT id FROM windows WHERE (?='window' AND id=?) OR (?='task' AND task_id=?) OR (?='project' AND (project_id=? OR task_id IN (SELECT id FROM tasks WHERE project_id=?)))))
    )`).all(kind, id, kind, id, kind, id, id, kind, id, kind, id, kind, id, kind, id, kind, id, id) as Array<{ id: number }>;
    for (const row of rows) this.notify(row.id);
    if (kind === 'window') this.notify(id);
    if (kind === 'project') {
      const origins = this.db.prepare('SELECT id FROM windows WHERE origin_project_id=?').all(id) as Array<{ id: number }>;
      for (const origin of origins) this.notify(origin.id);
    }
  }

  private find(source: number, subject: Subject): LinkRow | undefined {
    return ('windowId' in subject
      ? this.db.prepare('SELECT * FROM window_links WHERE source_window_id = ? AND target_window_id = ?').get(source, subject.windowId)
      : this.db.prepare('SELECT * FROM window_links WHERE source_window_id = ? AND task_id = ?').get(source, subject.taskId)) as LinkRow | undefined;
  }
  private check(source: number, subject: Subject): 'operation' | 'orchestration' | Rejection {
    const from = this.windows.findById(source);
    const target = 'windowId' in subject ? this.windows.findById(subject.windowId) : undefined;
    if (!from || ('windowId' in subject ? !target : !this.tasks.findById(subject.taskId))) return 'not_found';
    if (target?.id === source) return 'self_link';
    const kind = from.role === 'orchestrator' ? 'orchestration' : from.ownerType === 'task' && from.isPrimary && target?.taskId === from.taskId ? 'operation' : 'not_linkable';
    if (kind !== 'orchestration' || target?.role !== 'orchestrator') return kind;
    const parent = this.parentOf(target.id);
    if (parent !== null && parent !== source) return 'already_nested';
    const visited = new Set<number>();
    const visit = (id: number, depth: number): boolean => {
      if (id === source || depth >= 32) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      const children = this.db.prepare("SELECT target_window_id AS id FROM window_links WHERE source_window_id = ? AND kind = 'orchestration' AND unlinked_at IS NULL AND target_window_id IS NOT NULL").all(id) as Array<{ id: number }>;
      return children.some(child => visit(child.id, depth + 1));
    };
    return visit(target.id, 0) ? 'cycle' : kind;
  }
  add(sourceWindowId: number, subject: Subject, source: 'manual' | 'auto'): LinkRow | Rejection {
    return this.db.transaction(() => {
      const kind = this.check(sourceWindowId, subject);
      if (kind !== 'operation' && kind !== 'orchestration') return kind;
      const old = this.find(sourceWindowId, subject);
      if (old) {
        if (source === 'auto' && old.unlinked_at) return old;
        if (source === 'manual' && (old.unlinked_at || old.source !== 'manual')) {
          this.db.prepare("UPDATE window_links SET unlinked_at=NULL, source='manual', kind=? WHERE id=?").run(kind, old.id);
          this.notify(sourceWindowId);
          if ('windowId' in subject) this.notify(subject.windowId);
        } else if (source === 'auto') {
          const now = Date.now();
          this.pruneWrites(now);
          if (!this.lastWrites.has(old.id)) {
            this.db.prepare("UPDATE window_links SET last_interaction_at=datetime('now') WHERE id=?").run(old.id);
            this.lastWrites.set(old.id, now);
          }
        }
        return this.find(sourceWindowId, subject)!;
      }
      const result = this.db.prepare("INSERT INTO window_links (source_window_id, target_window_id, task_id, kind, source, last_interaction_at) VALUES (?, ?, ?, ?, ?, CASE WHEN ?='auto' THEN datetime('now') ELSE NULL END)").run(sourceWindowId, 'windowId' in subject ? subject.windowId : null, 'taskId' in subject ? subject.taskId : null, kind, source, source);
      if (source === 'auto') {
        const now = Date.now();
        this.pruneWrites(now);
        this.lastWrites.set(Number(result.lastInsertRowid), now);
      }
      this.notify(sourceWindowId);
      if ('windowId' in subject) this.notify(subject.windowId);
      return this.db.prepare('SELECT * FROM window_links WHERE id=?').get(result.lastInsertRowid) as LinkRow;
    })();
  }
  recordInteraction(sourceWindowId: number, subject: Subject): void { this.add(sourceWindowId, subject, 'auto'); }
  unlink(sourceWindowId: number, linkId: number): boolean {
    const old = this.db.prepare('SELECT target_window_id FROM window_links WHERE source_window_id=? AND id=? AND unlinked_at IS NULL').get(sourceWindowId, linkId) as { target_window_id: number | null } | undefined;
    const result = this.db.prepare("UPDATE window_links SET unlinked_at=datetime('now') WHERE source_window_id=? AND id=? AND unlinked_at IS NULL").run(sourceWindowId, linkId);
    if (result.changes) { this.notify(sourceWindowId); if (old?.target_window_id != null) this.notify(old.target_window_id); }
    return result.changes > 0;
  }
  parentOf(windowId: number): number | null {
    const row = this.db.prepare("SELECT source_window_id FROM window_links WHERE target_window_id=? AND kind='orchestration' AND unlinked_at IS NULL LIMIT 1").get(windowId) as { source_window_id: number } | undefined;
    return row?.source_window_id ?? null;
  }
  list(source: number, includeUnlinked = false, kind?: 'operation' | 'orchestration'): object[] {
    const rows = this.db.prepare(`SELECT * FROM window_links WHERE source_window_id=? ${includeUnlinked ? '' : 'AND unlinked_at IS NULL'} ${kind ? 'AND kind=?' : ''} ORDER BY id`).all(...(kind ? [source, kind] : [source])) as LinkRow[];
    return rows.map(r => ({ id: r.id, sourceWindowId: r.source_window_id, targetWindowId: r.target_window_id, taskId: r.task_id, kind: r.kind, source: r.source, createdAt: r.created_at, lastInteractionAt: r.last_interaction_at, unlinkedAt: r.unlinked_at, resolvedWindowId: r.task_id === null ? r.target_window_id : this.windows.findByTask(r.task_id).find(w => w.isPrimary)?.id ?? null }));
  }
  orchestrators(): object[] {
    return this.windows.findAll().filter(w => w.role === 'orchestrator').map(w => {
      const rows = this.db.prepare('SELECT * FROM window_links WHERE source_window_id=? AND unlinked_at IS NULL').all(w.id) as LinkRow[];
      const projects = new Set<number>(); const servers = new Set<string>();
      for (const row of rows) {
        const target: Window | undefined = row.target_window_id === null ? undefined : this.windows.findById(row.target_window_id);
        const task = row.task_id === null ? undefined : this.tasks.findById(row.task_id);
        const project = target?.projectId ?? task?.projectId;
        if (project != null) projects.add(project);
        if (target) servers.add(target.serverName);
        if (task) {
          const primary = this.windows.findByTask(task.id).find(window => window.isPrimary);
          if (primary) servers.add(primary.serverName);
          else if (task.serverName) servers.add(task.serverName);
        }
      }
      return { ...w, links: { total: rows.length, projectIds: [...projects], serverNames: [...servers] }, parentWindowId: this.parentOf(w.id) };
    });
  }
}
