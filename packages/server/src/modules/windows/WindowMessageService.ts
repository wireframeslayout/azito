import { formatWindowId, muxRefFromTmuxTarget, type PaneOrdinal } from '@azito/shared';
import type { Principal } from '../../shared/auth/Principal';
import type { IWindowRepository, Window } from './Window';
import type { ITaskRepository } from '../tasks/Task';
import type { IServerRepository } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { recordAuditBestEffort } from '../../shared/audit/recordAuditBestEffort';
import type { TmuxClient } from '../tmux/TmuxClient';
import { guardChatInput, type ChatInputRejection } from '../transcripts/chatInputGuard';

export type WindowMessageResult = 'ok' | 'not_found' | 'forbidden' | 'sleeping' | 'send_failed' | ChatInputRejection;

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

  async send(principal: Principal, destinationId: number, senderId: number | undefined, message: string, onAuditError: (err: unknown) => void): Promise<WindowMessageResult> {
    const destination = this.windows.findById(destinationId);
    if (!destination) return 'not_found';
    let sender: Window | undefined;
    if (principal.class === 'task') {
      sender = senderId === undefined ? undefined : this.windows.findById(senderId);
      if (!sender || sender.ownerType !== 'task' || sender.taskId !== principal.id) return 'forbidden';
      const projectId = this.projectId(sender);
      if (projectId === null || projectId !== this.projectId(destination) || sender.serverName !== destination.serverName) return 'forbidden';
    } else if (principal.class !== 'operator') return 'forbidden';
    if (destination.sleeping) return 'sleeping';
    const server = this.servers.findByName(destination.serverName);
    if (!server) return 'not_found';
    const ref = destination.muxRef ?? muxRefFromTmuxTarget(destination.tmuxTarget);
    const driver = this.drivers.resolveKind(ref.kind, server);
    const pane = await driver.resolvePane(server, ref, 1 as PaneOrdinal);
    if (driver.caps.copyMode && await driver.isPaneInModeByHandle(server, pane)) {
      await driver.cancelPaneModeByHandle(server, pane);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const rejection = await guardChatInput(driver, server, pane, destination.workerType, message);
    if (rejection) return rejection;
    let delivered = false;
    try {
      await driver.pasteTextToHandle(server, pane, `[from ${sender ? `${formatWindowId(sender.id)} · task #${sender.taskId}` : 'operator'}]\n${message}`);
      if (ref.kind === 'tmux') await (driver as TmuxClient).sendMessageEnter(server, pane);
      else await driver.sendKeysToHandle(server, pane, ['Enter']);
      delivered = true;
    } catch {
      return 'send_failed';
    } finally {
      recordAuditBestEffort(this.audit, { actorClass: principal.class, actorId: principal.id ?? null, event: 'window.message_sent', detail: { senderWindowId: sender?.id ?? null, destinationWindowId: destination.id, length: message.length, delivered } }, onAuditError);
    }
    return 'ok';
  }
}
