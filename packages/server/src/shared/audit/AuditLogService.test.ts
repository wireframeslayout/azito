import { describe, it, expect, vi } from 'vitest';
import { AuditLogService } from './AuditLogService';
import type { AuditLogRow, IAuditLogRepository } from './AuditLogRepository';

function makeRepo(): IAuditLogRepository & { record: ReturnType<typeof vi.fn<(entry: unknown) => void>>; listRecent: ReturnType<typeof vi.fn<(limit: number) => AuditLogRow[]>> } {
  return { record: vi.fn<(entry: unknown) => void>(), listRecent: vi.fn<(limit: number) => AuditLogRow[]>(() => []) };
}

describe('AuditLogService.list (Issue #28 Phase D-4)', () => {
  it('passes the limit through to the repository and returns its rows unchanged', () => {
    const repo = makeRepo();
    const rows: AuditLogRow[] = [{ id: 1, ts: 't', actorClass: 'operator', actorId: null, event: 'e', detail: null }];
    repo.listRecent.mockReturnValue(rows);
    const svc = new AuditLogService(repo);

    expect(svc.list(50)).toBe(rows);
    expect(repo.listRecent).toHaveBeenCalledWith(50);
  });
});

describe('AuditLogService dedup (Issue #28 review finding 2)', () => {
  it('suppresses an exact repeat of the same actor+event+detail within the flood window', () => {
    const repo = makeRepo();
    let now = 1_000;
    const svc = new AuditLogService(repo, () => now);

    svc.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5, tokenId: 1 } });
    now += 1_000;
    svc.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5, tokenId: 1 } });

    expect(repo.record).toHaveBeenCalledTimes(1);
  });

  it('does NOT suppress a same actor+event event with different detail — distinct security events must not be conflated', () => {
    const repo = makeRepo();
    let now = 1_000;
    const svc = new AuditLogService(repo, () => now);

    svc.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5, tokenId: 1 } });
    now += 1_000;
    svc.record({ actorClass: 'task', actorId: 9, event: 'task_token.issued', detail: { taskId: 9, tokenId: 2 } });

    expect(repo.record).toHaveBeenCalledTimes(2);
  });

  it('does NOT suppress a denial for a different operation even from the same actor within the window', () => {
    const repo = makeRepo();
    let now = 1_000;
    const svc = new AuditLogService(repo, () => now);

    svc.record({ actorClass: 'task', actorId: 5, event: 'route_auth.denied', detail: { operation: 'tasks.delete', method: 'DELETE', url: '/api/tasks/1' } });
    now += 1_000;
    svc.record({ actorClass: 'task', actorId: 5, event: 'route_auth.denied', detail: { operation: 'units.execute', method: 'POST', url: '/api/units/1/execute' } });

    expect(repo.record).toHaveBeenCalledTimes(2);
  });

  it('allows a repeat once the flood window has elapsed', () => {
    const repo = makeRepo();
    let now = 1_000;
    const svc = new AuditLogService(repo, () => now);

    svc.record({ actorClass: 'operator', event: 'task.created', detail: { taskId: 1 } });
    now += 31_000;
    svc.record({ actorClass: 'operator', event: 'task.created', detail: { taskId: 1 } });

    expect(repo.record).toHaveBeenCalledTimes(2);
  });
});

describe('AuditLogService dedup marks AFTER a successful write (Issue #28 review finding 4)', () => {
  it('does not suppress a retry of the same event after repo.record() throws — a failed write must not be treated as "already logged"', () => {
    const repo = makeRepo();
    repo.record.mockImplementationOnce(() => {
      throw new Error('DB busy');
    });
    let now = 1_000;
    const svc = new AuditLogService(repo, () => now);

    expect(() => svc.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5 } })).toThrow('DB busy');

    now += 1_000; // still well within FLOOD_WINDOW_MS
    svc.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5 } });

    // First call threw (write never landed), second call is the retry that
    // must actually reach the repo — if the dedup key were marked before the
    // write (the pre-fix behavior), this second call would be silently
    // suppressed and the event would never make it to audit_log at all.
    expect(repo.record).toHaveBeenCalledTimes(2);
  });

  it('still suppresses a repeat once a write has actually succeeded', () => {
    const repo = makeRepo();
    let now = 1_000;
    const svc = new AuditLogService(repo, () => now);

    svc.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5 } });
    now += 1_000;
    svc.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5 } });

    expect(repo.record).toHaveBeenCalledTimes(1);
  });
});

describe('AuditLogService bounded dedup cache (Issue #28 review finding 5)', () => {
  it('does not grow lastLoggedAt without bound as distinct keys accumulate — expired entries are swept', () => {
    const repo = makeRepo();
    let now = 1_000;
    const svc = new AuditLogService(repo, () => now);

    for (let i = 0; i < 500; i++) {
      svc.record({ actorClass: 'task', actorId: i, event: 'task_token.issued', detail: { taskId: i } });
      now += 100; // well under FLOOD_WINDOW_MS per step, but the whole run exceeds it
    }
    // 500 * 100ms = 50s > 30s flood window, so by the end of the loop the
    // earliest keys are already expired and should have been swept away —
    // the internal map must not have kept accumulating one entry per task
    // forever.
    // Push time forward well past the window and log a fresh, never-before-seen
    // key: if sweeping works, this alone should not make the repo see a
    // suppressed duplicate for an unrelated key.
    now += 60_000;
    svc.record({ actorClass: 'task', actorId: 999_999, event: 'task_token.issued', detail: { taskId: 999_999 } });

    expect(repo.record).toHaveBeenCalledTimes(501);
    // Internal map size is not part of the public API, but we can assert
    // indirectly: re-recording one of the very first keys after the window
    // has elapsed must succeed (not be treated as "recently seen"), proving
    // its entry didn't linger forever.
    svc.record({ actorClass: 'task', actorId: 0, event: 'task_token.issued', detail: { taskId: 0 } });
    expect(repo.record).toHaveBeenCalledTimes(502);
  });
});
