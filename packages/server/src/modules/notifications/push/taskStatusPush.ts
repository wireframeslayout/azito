import type { PushMessageKey } from './pushCatalog';

/**
 * The `status_change` statuses of a task's execution log that send a push notification, and the message each one sends. A failure the
 * task ends with must be here, or the task fails without anyone being told: `worker_not_ready` (the worker was at a dialog, a shell or
 * a screen that is not its input, so nothing was sent to it, #532) is a failure a person has to act on.
 */
export const STATUS_TO_PUSH_KEY: Readonly<Record<string, PushMessageKey>> = {
  done:              'task.done',
  error:             'task.error',
  stopped_by_user:   'task.stoppedByUser',
  send_error:        'task.sendError',
  worker_not_ready:  'task.sendError',
  codex_error:       'task.codexError',
  waiting_for_human: 'task.waitingForHuman',
  phase_review:      'task.phaseReview',
  pending_approval:  'task.pendingApproval',
};

/** The push message key for an execution-log entry, or null when it is not a status that notifies. */
export function pushKeyForLogEntry(entry: { type: string; content: { status?: string } }): PushMessageKey | null {
  if (entry.type !== 'status_change' || !entry.content.status) return null;
  return STATUS_TO_PUSH_KEY[entry.content.status] ?? null;
}
