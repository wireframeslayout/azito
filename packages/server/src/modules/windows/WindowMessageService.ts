import { formatWindowId, muxRefFromTmuxTarget, type PaneOrdinal } from '@azito/shared';
import type { Principal } from '../../shared/auth/Principal';
import type { IWindowRepository, Window } from './Window';
import type { ITaskRepository } from '../tasks/Task';
import type { IServerRepository } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { recordAuditBestEffort } from '../../shared/audit/recordAuditBestEffort';

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export class WindowMessageService {
  constructor(
    private windows: IWindowRepository,
    private tasks: ITaskRepository,
    private servers: IServerRepository,
    private drivers: MuxDriverRegistry,
    private audit: AuditLogService,
  ) {}

  private projectId(window: Window): number | null {
    if (window.projectId !== null) return window.projectId;
    return window.taskId === null ? null : this.tasks.findById(window.taskId)?.projectId ?? null;
  }

  async send(principal: Principal, destinationId: number, senderId: number | undefined, message: string, onAuditError: (err: unknown) => void): Promise<void> {
    const destination = this.windows.findById(destinationId);
    if (!destination) fail(404, 'Window not found');
    let sender: Window | undefined;
    if (principal.class === 'task') {
      sender = senderId === undefined ? undefined : this.windows.findById(senderId);
      if (!sender || sender.ownerType !== 'task' || sender.taskId !== principal.id) fail(403, 'Forbidden');
      const projectId = this.projectId(sender);
      if (projectId === null || projectId !== this.projectId(destination) || sender.serverName !== destination.serverName) fail(403, 'Forbidden');
    } else if (principal.class !== 'operator') fail(403, 'Forbidden');
    if (destination.sleeping) fail(409, 'Window is sleeping');
    const server = this.servers.findByName(destination.serverName);
    if (!server) fail(404, 'Server not found');
    const ref = destination.muxRef ?? muxRefFromTmuxTarget(destination.tmuxTarget);
    const driver = this.drivers.resolveKind(ref.kind, server);
    const pane = await driver.resolvePane(server, ref, 1 as PaneOrdinal);
    await driver.pasteTextToHandle(server, pane, `[from ${sender ? `${formatWindowId(sender.id)} · task #${sender.taskId}` : 'operator'}]\n${message}`);
    await driver.sendKeysToHandle(server, pane, ['Enter']);
    recordAuditBestEffort(this.audit, { actorClass: principal.class, actorId: principal.id ?? null, event: 'window.message_sent', detail: { senderWindowId: sender?.id ?? null, destinationWindowId: destination.id, length: message.length } }, onAuditError);
  }
}
