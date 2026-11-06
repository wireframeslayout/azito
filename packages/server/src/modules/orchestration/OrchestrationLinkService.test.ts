import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../shared/db/Database';
import { SqliteWindowRepository } from '../windows/SqliteWindowRepository';
import type { ITaskRepository } from '../tasks/Task';
import { NotificationBus } from '../notifications/NotificationBus';
import { OrchestrationLinkService } from './OrchestrationLinkService';
import { WindowRoleService } from '../windows/WindowRoleService';

describe('orchestration links and roles', () => {
  it('enforces nesting, preserves manual unlinks, and restores ownership', () => {
    const db = openDatabase(':memory:');
    db.exec("INSERT INTO projects (id,name,slug) VALUES (1,'P','p'); INSERT INTO windows (id,owner_type,project_id,server_name,tmux_target,window_type,worker_type) VALUES (1,'project',1,'local','s:a','agent','claude'), (2,'project',1,'local','s:b','agent','claude'), (3,'project',1,'local','s:c','agent','claude')");
    const windows = new SqliteWindowRepository(db); const bus = new NotificationBus(); const notify = vi.fn(); bus.on(notify);
    const links = new OrchestrationLinkService(db, windows, { findById: () => undefined } as unknown as ITaskRepository, bus);
    const roles = new WindowRoleService(db, windows, bus);
    expect(roles.set(1, 'orchestrator')).toBe('ok');
    expect(roles.set(2, 'orchestrator')).toBe('ok');
    expect(roles.set(3, 'orchestrator')).toBe('ok');
    expect(windows.findById(1)).toMatchObject({ ownerType: 'server', projectId: null, originProjectId: 1 });
    const first = links.add(1, { windowId: 2 }, 'manual');
    expect(typeof first).toBe('object');
    expect(links.add(2, { windowId: 1 }, 'manual')).toBe('cycle');
    expect(links.add(3, { windowId: 2 }, 'manual')).toBe('already_nested');
    expect(links.add(1, { windowId: 1 }, 'manual')).toBe('self_link');
    if (typeof first === 'string') throw new Error(first);
    expect(links.unlink(1, first.id)).toBe(true);
    links.recordInteraction(1, { windowId: 2 });
    expect(links.list(1)).toHaveLength(0);
    links.add(1, { windowId: 2 }, 'manual');
    expect(links.list(1)).toHaveLength(1);
    notify.mockClear();
    links.notifyDeletion('window', 2);
    expect(notify).toHaveBeenCalledWith({ type: 'orchestration:updated', payload: { windowId: 1 } });
    expect(roles.set(1, null)).toBe('ok');
    expect(windows.findById(1)).toMatchObject({ ownerType: 'project', projectId: 1, role: null });
    expect(links.list(1)).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith({ type: 'orchestration:updated', payload: { windowId: 1 } });
    db.close(); bus.destroy();
  });
  it('throttles existing links individually while creating new links immediately', () => {
    const db = openDatabase(':memory:');
    db.exec("INSERT INTO windows (id,owner_type,server_name,tmux_target,window_type,worker_type,role) VALUES (1,'server','local','s:a','agent','claude','orchestrator'), (2,'server','local','s:b','agent','claude',NULL), (3,'server','local','s:c','agent','claude',NULL)");
    const bus = new NotificationBus();
    const links = new OrchestrationLinkService(db, new SqliteWindowRepository(db), { findById: () => undefined } as unknown as ITaskRepository, bus);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
    links.recordInteraction(1, { windowId: 2 });
    links.recordInteraction(1, { windowId: 2 });
    db.exec("UPDATE window_links SET last_interaction_at='sentinel' WHERE target_window_id=2");
    clock.mockReturnValue(12000);
    links.recordInteraction(1, { windowId: 2 });
    links.recordInteraction(1, { windowId: 3 });
    expect(db.prepare('SELECT last_interaction_at FROM window_links WHERE target_window_id=2').get()).toEqual({ last_interaction_at: 'sentinel' });
    expect(links.list(1)).toHaveLength(2);
    clock.mockReturnValue(15000);
    links.recordInteraction(1, { windowId: 2 });
    expect(db.prepare('SELECT last_interaction_at FROM window_links WHERE target_window_id=2').get()).not.toEqual({ last_interaction_at: 'sentinel' });
    clock.mockRestore(); bus.destroy(); db.close();
  });

  it('resolves a task target to its primary window and reports deletion to its source', () => {
    const db = openDatabase(':memory:');
    db.exec("INSERT INTO projects (id,name,slug) VALUES (1,'P','p'); INSERT INTO tasks (id,project_id,title) VALUES (1,1,'T'); INSERT INTO windows (id,owner_type,server_name,tmux_target,window_type,worker_type,role) VALUES (1,'server','local','s:a','agent','claude','orchestrator'); INSERT INTO windows (id,owner_type,task_id,project_id,server_name,tmux_target,is_primary) VALUES (2,'task',1,1,'local','s:b',1)");
    const bus = new NotificationBus(); const notify = vi.fn(); bus.on(notify);
    const windows = new SqliteWindowRepository(db);
    const links = new OrchestrationLinkService(db, windows, { findById: () => ({ id: 1, projectId: 1, serverName: 'local' }) } as unknown as ITaskRepository, bus);
    links.recordInteraction(1, { taskId: 1 });
    expect(links.list(1)).toMatchObject([{ taskId: 1, resolvedWindowId: 2 }]);
    expect(links.orchestrators()).toMatchObject([{ links: { total: 1, projectIds: [1], serverNames: ['local'] } }]);
    notify.mockClear();
    links.notifyDeletion('task', 1);
    expect(notify).toHaveBeenCalledWith({ type: 'orchestration:updated', payload: { windowId: 1 } });
    db.exec('DELETE FROM tasks WHERE id=1');
    expect(links.list(1)).toHaveLength(0);
    bus.destroy(); db.close();
  });

  it('rejects terminal and task windows, and retains server ownership after project deletion', () => {
    const db = openDatabase(':memory:');
    db.exec("INSERT INTO projects (id,name,slug) VALUES (1,'P','p'); INSERT INTO tasks (id,project_id,title) VALUES (1,1,'T'); INSERT INTO windows (id,owner_type,project_id,server_name,tmux_target,window_type) VALUES (1,'project',1,'local','s:a','terminal'); INSERT INTO windows (id,owner_type,task_id,project_id,server_name,tmux_target,window_type,worker_type) VALUES (2,'task',1,1,'local','s:b','agent','claude'); INSERT INTO windows (id,owner_type,project_id,server_name,tmux_target,window_type,worker_type) VALUES (3,'project',1,'local','s:c','agent','claude')");
    const bus = new NotificationBus(); const windows = new SqliteWindowRepository(db); const roles = new WindowRoleService(db, windows, bus);
    expect(roles.set(1, 'orchestrator')).toBe('not_agent_window');
    expect(roles.set(2, 'orchestrator')).toBe('task_owned_window');
    expect(roles.set(3, 'orchestrator')).toBe('ok');
    expect(roles.set(3, 'orchestrator')).toBe('ok');
    db.exec('DELETE FROM projects WHERE id=1');
    expect(roles.set(3, null)).toBe('ok');
    expect(windows.findById(3)).toMatchObject({ ownerType: 'server', originProjectId: null, role: null });
    bus.destroy(); db.close();
  });

});
