import { describe, expect, it, vi } from 'vitest';
import { WindowMessageService } from './WindowMessageService';
import type { IWindowRepository, Window } from './Window';
import type { ITaskRepository } from '../tasks/Task';
import type { IServerRepository } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { AuditLogService } from '../../shared/audit/AuditLogService';

function setup() {
  const windows = new Map<number, Window>([
    [1, { id: 1, ownerType: 'task', taskId: 10, projectId: null, serverName: 'local', tmuxTarget: 's:a', sleeping: false, workerType: 'claude' } as Window],
    [2, { id: 2, ownerType: 'project', taskId: null, projectId: 5, serverName: 'local', tmuxTarget: 's:b', sleeping: false, workerType: 'claude' } as Window],
  ]);
  const driver = { sendMessageEnter: vi.fn().mockResolvedValue(undefined), caps: { copyMode: false }, captureScreen: vi.fn().mockResolvedValue({ code: 0, stdout: '──────────────\n❯\n──────────────\nbypass permissions on' }), resolvePane: vi.fn().mockResolvedValue('%2'), pasteTextToHandle: vi.fn().mockResolvedValue(undefined), sendKeysToHandle: vi.fn().mockResolvedValue(undefined), paneCommandByHandle: vi.fn().mockResolvedValue('claude') };
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
    expect(driver.sendMessageEnter).toHaveBeenCalledWith(expect.anything(), '%2');
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
    await expect(service.send({ class: 'task', id: 11 }, 2, 1, 'hello', vi.fn())).resolves.toBe('forbidden');
    windows.set(2, { ...windows.get(2)!, serverName: 'other' });
    await expect(service.send({ class: 'task', id: 10 }, 2, 1, 'hello', vi.fn())).resolves.toBe('forbidden');
    expect(driver.pasteTextToHandle).not.toHaveBeenCalled();
  });
  it('rejects sleeping and missing destinations and propagates send failures', async () => {
    const { service, windows, driver, record } = setup();
    windows.set(2, { ...windows.get(2)!, sleeping: true });
    await expect(service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).resolves.toBe('sleeping');
    await expect(service.send({ class: 'operator' }, 3, undefined, 'hello', vi.fn())).resolves.toBe('not_found');
    windows.set(2, { ...windows.get(2)!, sleeping: false });
    driver.sendMessageEnter.mockRejectedValue(new Error('failure'));
    await expect(service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).resolves.toBe('send_failed');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ delivered: false }) }));
  });
  it('refuses a destination pane at a shell or with an unknown process before typing', async () => {
    const { service, driver } = setup();
    driver.paneCommandByHandle.mockResolvedValueOnce('bash');
    await expect(service.send({ class: 'operator' }, 2, undefined, 'rm -rf ~', vi.fn())).resolves.toMatchObject({ code: 'worker_exited_to_shell' });
    driver.paneCommandByHandle.mockResolvedValueOnce(null);
    await expect(service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).resolves.toMatchObject({ code: 'pane_unavailable' });
    expect(driver.pasteTextToHandle).not.toHaveBeenCalled();
    expect(driver.sendKeysToHandle).not.toHaveBeenCalled();
  });
  it('rejects a dialog, an existing draft and unsupported workers without sending', async () => {
    const { service, driver, windows } = setup();
    driver.captureScreen.mockResolvedValueOnce({ code: 0, stdout: 'Do you trust this folder?' });
    expect(await service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).toMatchObject({ code: 'trust_dialog' });
    driver.captureScreen.mockResolvedValueOnce({ code: 0, stdout: '──────────────\n❯ existing draft\n──────────────\nbypass permissions on' });
    expect(await service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).toMatchObject({ code: 'input_not_empty' });
    windows.set(2, { ...windows.get(2)!, workerType: 'generic' });
    expect(await service.send({ class: 'operator' }, 2, undefined, 'hello', vi.fn())).toMatchObject({ code: 'unsupported_worker' });
    expect(driver.pasteTextToHandle).not.toHaveBeenCalled();
  });

});
