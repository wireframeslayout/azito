import type { Database } from 'better-sqlite3';
import type { NotificationBus } from '../notifications/NotificationBus';
import type { IWindowRepository } from '../windows/Window';
import type { ITaskRepository } from '../tasks/Task';
import { SqliteWindowLinkRepository } from './SqliteWindowLinkRepository';
import type { WindowLinkView, OrchestratorSummary } from './WindowLink';

type Subject = { windowId: number } | { taskId: number };
type Rejection = 'not_linkable' | 'self_link' | 'already_nested' | 'cycle' | 'not_found';
interface LinkRow { id: number; source_window_id: number; target_window_id: number | null; task_id: number | null; kind: 'operation' | 'orchestration'; source: 'manual' | 'auto'; created_at: string; last_interaction_at: string | null; unlinked_at: string | null }

export class OrchestrationLinkService {
  private lastWrites = new Map<number, number>();
  private linkRepo: SqliteWindowLinkRepository;
  constructor(private db: Database, private windows: IWindowRepository, private tasks: ITaskRepository, private bus: NotificationBus) { this.linkRepo = new SqliteWindowLinkRepository(db); }

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
    if (kind === 'window' && (rows.length > 0 || this.windows.findById(id)?.role === 'orchestrator')) this.notify(id);
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
  incomingSources(windowId: number): number[] { return this.linkRepo.incomingSources(windowId); }
  unlinkAllFrom(windowId: number): void {
    for (const link of this.linkRepo.activeFrom(windowId)) this.unlink(windowId, link.id);
  }
  list(source: number, includeUnlinked = false, kind?: WindowLinkView['kind']): WindowLinkView[] {
    return this.linkRepo.list(source, includeUnlinked, kind);
  }
  orchestrators(): OrchestratorSummary[] {
    const rows = this.linkRepo.activeForOrchestrators();
    const grouped = new Map<number, typeof rows>();
    const parents = new Map<number, number>();
    for (const row of rows) {
      const group = grouped.get(row.source_window_id) ?? [];
      group.push(row); grouped.set(row.source_window_id, group);
      if (row.kind === 'orchestration' && row.target_window_id !== null && !parents.has(row.target_window_id)) parents.set(row.target_window_id, row.source_window_id);
    }
    return this.windows.findOrchestrators().map(w => {
      const links = grouped.get(w.id) ?? [];
      return { ...w, links: { total: links.length,
        projectIds: [...new Set(links.flatMap(row => row.project_id === null ? [] : [row.project_id]))],
        serverNames: [...new Set(links.flatMap(row => row.server_name === null ? [] : [row.server_name]))],
      }, parentWindowId: parents.get(w.id) ?? null };
    });
  }
}
