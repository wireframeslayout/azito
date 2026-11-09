import type { NotificationBus } from '../notifications/NotificationBus';
import { isPrimaryTaskWindow, type IWindowRepository } from '../windows/Window';
import type { ITaskRepository } from '../tasks/Task';
import type { SqliteWindowLinkRepository, LinkSubject, LinkRow } from './SqliteWindowLinkRepository';
import type { WindowLinkView, OrchestratorSummary } from './WindowLink';

type Rejection = 'not_linkable' | 'self_link' | 'already_nested' | 'cycle' | 'not_found';

export class OrchestrationLinkService {
  private lastWrites = new Map<number, number>();
  constructor(private linkRepo: SqliteWindowLinkRepository, private windows: IWindowRepository, private tasks: ITaskRepository, private bus: NotificationBus) {}

  private pruneWrites(now: number): void {
    for (const [key, time] of this.lastWrites) if (now - time >= 5000) this.lastWrites.delete(key);
  }
  private notify(windowId: number): void { this.bus.emit({ type: 'orchestration:updated', payload: { windowId } }); }
  notifyDeletion(kind: 'window' | 'task' | 'project', id: number): void {
    const rows = this.linkRepo.affectedSources(kind, id);
    for (const source of rows) this.notify(source);
    if (kind === 'window' && (rows.length > 0 || this.windows.findById(id)?.role === 'orchestrator')) this.notify(id);
    if (kind === 'project') for (const origin of this.linkRepo.projectOrigins(id)) this.notify(origin);
  }

  private check(source: number, subject: LinkSubject): 'operation' | 'orchestration' | Rejection {
    const from = this.windows.findById(source);
    const target = 'windowId' in subject ? this.windows.findById(subject.windowId) : undefined;
    if (!from || ('windowId' in subject ? !target : !this.tasks.findById(subject.taskId))) return 'not_found';
    if (target?.id === source) return 'self_link';
    const kind = from.role === 'orchestrator' ? 'orchestration' : isPrimaryTaskWindow(from) && target?.ownerType === 'task' && !target.isPrimary && from.taskId !== null && target.taskId === from.taskId ? 'operation' : 'not_linkable';
    if (kind === 'operation' && target && this.linkRepo.operationParentOf(target.id, source) !== null) return 'already_nested';
    if (kind !== 'orchestration' || target?.role !== 'orchestrator') return kind;
    const parent = this.parentOf(target.id);
    if (parent !== null && parent !== source) return 'already_nested';
    const visited = new Set<number>();
    const visit = (id: number, depth: number): boolean => {
      if (id === source || depth >= 32) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return this.linkRepo.children(id).some(child => visit(child, depth + 1));
    };
    return visit(target.id, 0) ? 'cycle' : kind;
  }
  add(sourceWindowId: number, subject: LinkSubject, source: 'manual' | 'auto'): LinkRow | Rejection {
    return this.linkRepo.transaction(() => {
      const kind = this.check(sourceWindowId, subject);
      if (kind !== 'operation' && kind !== 'orchestration') return kind;
      if (kind === 'operation' && source === 'manual') return 'not_linkable';
      const old = this.linkRepo.find(sourceWindowId, subject);
      if (old) {
        if (old.kind !== kind) return 'not_linkable';
        if (source === 'auto' && old.unlinked_at) return old;
        if (source === 'manual' && (old.unlinked_at || old.source !== 'manual')) {
          this.linkRepo.restore(old.id, kind);
          this.notify(sourceWindowId);
          if ('windowId' in subject) this.notify(subject.windowId);
        } else if (source === 'auto') {
          const now = Date.now();
          this.pruneWrites(now);
          if (!this.lastWrites.has(old.id)) {
            this.linkRepo.touch(old.id);
            this.lastWrites.set(old.id, now);
          }
        }
        return this.linkRepo.find(sourceWindowId, subject)!;
      }
      const result = this.linkRepo.insert(sourceWindowId, subject, kind, source);
      if (source === 'auto') {
        const now = Date.now();
        this.pruneWrites(now);
        this.lastWrites.set(result.id, now);
      }
      this.notify(sourceWindowId);
      if ('windowId' in subject) this.notify(subject.windowId);
      return result;
    });
  }
  recordInteraction(sourceWindowId: number, subject: LinkSubject): void { this.add(sourceWindowId, subject, 'auto'); }
  unlink(sourceWindowId: number, linkId: number): boolean {
    const old = this.linkRepo.unlink(sourceWindowId, linkId);
    if (old) { this.notify(sourceWindowId); if (old.targetWindowId != null) this.notify(old.targetWindowId); }
    return old !== undefined;
  }
  parentOf(windowId: number): number | null { return this.linkRepo.parentOf(windowId); }

  incomingSources(windowId: number): number[] { return this.linkRepo.incomingSources(windowId); }
  unlinkAllFrom(windowId: number): void {
    for (const link of this.linkRepo.activeFrom(windowId)) this.unlink(windowId, link.id);
  }
  list(source: number, includeUnlinked = false, kind?: WindowLinkView['kind']): WindowLinkView[] {
    return this.linkRepo.list(source, includeUnlinked, kind);
  }
  operationLinks(taskIds: number[]): Array<{ sourceWindowId: number; targetWindowId: number }> { return this.linkRepo.operationLinks(taskIds); }
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
