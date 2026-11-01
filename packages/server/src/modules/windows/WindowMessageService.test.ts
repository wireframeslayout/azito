import { describe, expect, it, vi } from 'vitest';
import { WindowMessageService } from './WindowMessageService';
import type { IWindowRepository, Window } from './Window';
import type { ITaskRepository } from '../tasks/Task';
import type { IServerRepository } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { AuditLogService } from '../../shared/audit/AuditLogService';

function setup() {
  const windows = new Map<number, Window>([
    [1, { id: 1, ownerType: 'task', taskId: 10, projectId: null, serverName: 'local', tmuxTarget: 's:a', sleeping: false } as Window],
    [2, { id: 2, ownerType: 'project', taskId: null, projectId: 5, serverName: 'local', tmuxTarget: 's:b', sleeping: false } as Window],
  ]);
  const driver = { resolvePane: vi.fn().mockResolvedValue('%2'), pasteTextToHandle: vi.fn().mockResolvedValue(undefined), sendKeysToHandle: vi.fn().mockResolvedValue(undefined) };
  const record = vi.fn();
  const resolveKind = vi.fn(() => driver);
  const service = new WindowMessageService(
    { findById: (id: number) => windows.get(id) } as IWindowRepository,
    { findById: () => ({ projectId: 5 }) } as unknown as ITaskRepository,
    { findByName: () => ({ name: 'local' }) } as unknown as IServerRepository,
    { resolveKind } as unknown as MuxDriverRegistry,
    { record } as unknown as AuditLogService,
  );
  return { service, driver, windows, record, resolveKind };
}

describe('WindowMessageService', () => {
  it('sends and audits without recording the text', async () => {
    const { service, driver, record } = setup();
    await service.send({ class: 'task', id: 10 }, 2, 1, 'secret\ntext', vi.fn());
    expect(driver.pasteTextToHandle).toHaveBeenCalledWith(expect.anything(), '%2', '[from W-1 · task #10]\nsecret\ntext');
    expect(driver.sendKeysToHandle).toHaveBeenCalledWith(expect.anything(), '%2', ['Enter']);
    expect(JSON.stringify(record.mock.calls)).not.toContain('secret');
  });
  it('selects the destination ref driver even when it differs from the server default', async () => {
    const { service, windows, resolveKind } = setup();
    windows.set(2, { ...windows.get(2)!, muxRef: { kind: 'misao', workspace: 'ws', window: 'w_1' } });
    await service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn());
    expect(resolveKind).toHaveBeenCalledWith('misao', expect.objectContaining({ name: 'local' }));
  });
  it('rejects another task and another server', async () => {
    const { service, windows, driver } = setup();
    await expect(service.send({ class: 'task', id: 11 }, 2, 1, 'hello', vi.fn())).rejects.toMatchObject({ statusCode: 403 });
    windows.set(2, { ...windows.get(2)!, serverName: 'other' });
    await expect(service.send({ class: 'task', id: 10 }, 2, 1, 'hello', vi.fn())).rejects.toMatchObject({ statusCode: 403 });
    expect(driver.pasteTextToHandle).not.toHaveBeenCalled();
  });
  it('rejects sleeping and missing destinations and propagates send failures', async () => {
    const { service, windows, driver, record } = setup();
    windows.set(2, { ...windows.get(2)!, sleeping: true });
    await expect(service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.send({ class: 'operator' }, 3, undefined, 'hello', vi.fn())).rejects.toMatchObject({ statusCode: 404 });
    windows.set(2, { ...windows.get(2)!, sleeping: false });
    driver.sendKeysToHandle.mockRejectedValue(new Error('failure'));
    await expect(service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).rejects.toThrow('failure');
    expect(record).not.toHaveBeenCalled();
  });
});
