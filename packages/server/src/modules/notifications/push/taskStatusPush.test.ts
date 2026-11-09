import { describe, it, expect } from 'vitest';
import { getPushMessage } from './pushCatalog';
import { pushKeyForLogEntry, STATUS_TO_PUSH_KEY } from './taskStatusPush';

describe('pushKeyForLogEntry', () => {
  it('notifies when a worker could not take the prompt (worker_not_ready, #532), like a send error', () => {
    expect(pushKeyForLogEntry({ type: 'status_change', content: { status: 'worker_not_ready' } })).toBe('task.sendError');
    expect(pushKeyForLogEntry({ type: 'status_change', content: { status: 'send_error' } })).toBe('task.sendError');
  });

  it('notifies a launch the CLI refused (worker_launch_failed, #639) with its own message, without it being a task status', () => {
    expect(pushKeyForLogEntry({ type: 'status_change', content: { status: 'worker_launch_failed' } })).toBe('task.workerLaunchFailed');
    // The notification-only status is distinct from every real task status.
    expect(STATUS_TO_PUSH_KEY).not.toHaveProperty('done', 'task.workerLaunchFailed');
  });

  it('has a message in both languages for every status it maps', () => {
    for (const key of new Set(Object.values(STATUS_TO_PUSH_KEY))) {
      for (const lang of ['en', 'ja'] as const) expect(getPushMessage(lang, key, { taskTitle: 'T' }).title).not.toBe('');
    }
  });

  it('ignores other log types and unknown statuses', () => {
    expect(pushKeyForLogEntry({ type: 'command', content: { status: 'worker_not_ready' } })).toBeNull();
    expect(pushKeyForLogEntry({ type: 'status_change', content: { status: 'started' } })).toBeNull();
    expect(pushKeyForLogEntry({ type: 'status_change', content: {} })).toBeNull();
  });
});
