import type { Database } from 'better-sqlite3';
import type { IWindowRepository } from './Window';
import type { IProjectRepository } from '../projects/Project';
import type { NotificationBus } from '../notifications/NotificationBus';

export interface RoleLinks { incomingSources(windowId: number): number[]; unlinkAllFrom(windowId: number): void }

export class WindowRoleService {
  constructor(private db: Database, private windows: IWindowRepository, private bus: NotificationBus, private projects: Pick<IProjectRepository, 'findById'>, private links: RoleLinks) {}
  set(id: number, role: 'orchestrator' | null): 'not_found' | 'not_agent_window' | 'task_owned_window' | 'already_nested' | 'ok' {
    return this.db.transaction(() => {
      const win = this.windows.findById(id);
      if (!win) return 'not_found';
      if (win.role === role) return 'ok';
      const affected = this.links.incomingSources(id);
      if (role) {
        if (win.ownerType === 'task') return 'task_owned_window';
        if (win.windowType !== 'agent' || !win.workerType) return 'not_agent_window';
        if (affected.length > 1) return 'already_nested';
        this.db.prepare("UPDATE windows SET role='orchestrator', origin_project_id=project_id, project_id=NULL, owner_type='server' WHERE id=?").run(id);
      } else {
        const project = win.originProjectId === null ? undefined : this.projects.findById(win.originProjectId);
        this.db.prepare('UPDATE windows SET role=NULL, origin_project_id=NULL, project_id=?, owner_type=? WHERE id=?').run(project ? win.originProjectId : null, project ? 'project' : 'server', id);
        this.links.unlinkAllFrom(id);
      }
      this.bus.emit({ type: 'orchestration:updated', payload: { windowId: id } });
      for (const source of affected) this.bus.emit({ type: 'orchestration:updated', payload: { windowId: source } });
      return 'ok';
    })();
  }
}
