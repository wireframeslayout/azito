import type { Database } from 'better-sqlite3';
import type { IWindowRepository } from './Window';
import type { NotificationBus } from '../notifications/NotificationBus';

export class WindowRoleService {
  constructor(private db: Database, private windows: IWindowRepository, private bus: NotificationBus) {}
  set(id: number, role: 'orchestrator' | null): 'not_found' | 'not_agent_window' | 'task_owned_window' | 'already_nested' | 'ok' {
    return this.db.transaction(() => {
      const win = this.windows.findById(id);
      if (!win) return 'not_found';
      if (win.role === role) return 'ok';
      const affected = this.db.prepare('SELECT DISTINCT source_window_id AS id FROM window_links WHERE target_window_id=? AND unlinked_at IS NULL').all(id) as Array<{ id: number }>;
      if (role) {
        if (win.ownerType === 'task') return 'task_owned_window';
        if (affected.length > 1) return 'already_nested';
        if (win.windowType !== 'agent' || !win.workerType) return 'not_agent_window';
        this.db.prepare("UPDATE windows SET role='orchestrator', origin_project_id=project_id, project_id=NULL, owner_type='server' WHERE id=?").run(id);
      } else {
        const project = win.originProjectId === null ? undefined : this.db.prepare('SELECT id FROM projects WHERE id=?').get(win.originProjectId);
        this.db.prepare('UPDATE windows SET role=NULL, origin_project_id=NULL, project_id=?, owner_type=? WHERE id=?').run(project ? win.originProjectId : null, project ? 'project' : 'server', id);
        this.db.prepare("UPDATE window_links SET unlinked_at=datetime('now') WHERE source_window_id=? AND unlinked_at IS NULL").run(id);
      }
      this.bus.emit({ type: 'orchestration:updated', payload: { windowId: id } });
      for (const source of affected) this.bus.emit({ type: 'orchestration:updated', payload: { windowId: source.id } });
      return 'ok';
    })();
  }
}
