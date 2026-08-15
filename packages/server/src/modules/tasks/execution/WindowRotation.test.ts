import { describe, it, expect, vi } from 'vitest';
import { createRotatedWindow, rollbackWindowReference, runExclusiveForTask } from './WindowRotation';
import { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';
import type { ITaskTokenRepository, IssuedTaskToken } from '../tokens/TaskToken';
import type { Task } from '../Task';
import type { ServerConfig } from '../../servers/Server';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 7,
    unitId: null,
    serverName: null,
    title: 'Test task',
    description: null,
    status: 'open',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: false,
    source: 'local',
    sourceRef: null,
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: null,
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: null,
    planMarkdown: null,
    pendingQuestions: null,
    changedFiles: null,
    summaryJson: null,
    prUrl: null,
    agentSessionId: null,
    inputTrust: 'trusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: null,
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: null,
    createdByKind: 'operator',
    createdById: null,
    createdViaGeneration: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'srv',
    type: 'local',
    host: null,
    agentPort: null,
    agentToken: null,
    agentVersion: null,
    sshHost: null,
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null,
    muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Minimal in-memory stand-in for the real SqliteTaskTokenRepository, faithful
 * to the two invariants these tests rely on: `issueNextGeneration` revokes
 * every currently-active row for the task before inserting the new one (same
 * "at most one active generation" contract the real repo's transaction
 * guarantees — see ITaskTokenRepository.issueNextGeneration's doc comment),
 * and `revoke` only ever touches the single row it's given.
 */
class FakeTaskTokenRepo implements ITaskTokenRepository {
  private rows = new Map<number, { taskId: number; windowGeneration: number; revoked: boolean }>();
  private nextId = 1;

  issue(taskId: number, windowGeneration: number): IssuedTaskToken {
    const id = this.nextId++;
    this.rows.set(id, { taskId, windowGeneration, revoked: false });
    return { id, token: `azt.task.${taskId}.${'a'.repeat(64)}` };
  }

  verify(_taskId: number, _secret: string): boolean {
    return false;
  }

  revokeAllForTask(taskId: number, _reason: string): number {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.taskId === taskId && !row.revoked) {
        row.revoked = true;
        n++;
      }
    }
    return n;
  }

  revoke(tokenId: number, _reason: string): number {
    const row = this.rows.get(tokenId);
    if (!row || row.revoked) return 0;
    row.revoked = true;
    return 1;
  }

  issueNextGeneration(taskId: number, revokeReason: string): IssuedTaskToken {
    this.revokeAllForTask(taskId, revokeReason);
    const nextGeneration = [...this.rows.values()].filter((r) => r.taskId === taskId).length + 1;
    return this.issue(taskId, nextGeneration);
  }

  getActiveGeneration(taskId: number): number | null {
    for (const row of this.rows.values()) {
      if (row.taskId === taskId && !row.revoked) return row.windowGeneration;
    }
    return null;
  }

  isActive(tokenId: number): boolean {
    return this.rows.get(tokenId)?.revoked === false;
  }
}

/** Resolves/rejects `create()` only once `release()` is called — lets tests control interleaving. */
function makeGate<T>(): { promise: Promise<T>; release: (value: T) => void; fail: (err: Error) => void } {
  let release!: (value: T) => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

describe('runExclusiveForTask', () => {
  it('serializes concurrent operations for the same taskId (second only starts once the first settles)', async () => {
    const order: string[] = [];
    const gateA = makeGate<void>();

    const a = runExclusiveForTask(1, async () => {
      order.push('a-start');
      await gateA.promise;
      order.push('a-end');
    });
    const b = runExclusiveForTask(1, async () => {
      order.push('b-start');
    });

    // b must not have started yet — it's queued behind a's still-pending gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    gateA.release();
    await a;
    await b;

    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('runs operations for DIFFERENT taskIds concurrently (no cross-task serialization)', async () => {
    const order: string[] = [];
    const gate1 = makeGate<void>();

    const p1 = runExclusiveForTask(1, async () => {
      order.push('task1-start');
      await gate1.promise;
      order.push('task1-end');
    });
    const p2 = runExclusiveForTask(2, async () => {
      order.push('task2-start');
    });

    await p2;
    expect(order).toEqual(['task1-start', 'task2-start']);

    gate1.release();
    await p1;
    expect(order).toEqual(['task1-start', 'task2-start', 'task1-end']);
  });

  it('queues a later call even when an earlier one for the same task REJECTS', async () => {
    const order: string[] = [];

    const a = runExclusiveForTask(3, async () => {
      order.push('a');
      throw new Error('a failed');
    });
    const b = runExclusiveForTask(3, async () => {
      order.push('b');
    });

    await expect(a).rejects.toThrow('a failed');
    await expect(b).resolves.toBeUndefined();
    expect(order).toEqual(['a', 'b']);
  });
});

// Issue #28 third-party review, Important finding: WindowRotation's kill->
// issue->create->persist span must be serialized per task, AND a rollback
// must revoke only the specific generation it issued — never every active
// generation for the task. These tests exercise both fixes together against
// the same interleaving the review described: two concurrent rotations for
// one task, where the OLDER one's create() fails after the NEWER one has
// already issued (and would, pre-fix, have revoked the older generation out
// from under it — or, without the lock, been revoked BY the newer one's own
// issuance mid-flight).
describe('createRotatedWindow + rollbackWindowReference under runExclusiveForTask (Issue #28 third-party review, WindowRotation.ts finding)', () => {
  function makeServices() {
    const tokenRepo = new FakeTaskTokenRepo();
    const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []) } as any;
    const paneEnvService = new TaskPaneEnvironmentService(tokenRepo, projectSecretRepo, 'ui-token', true);
    return { tokenRepo, paneEnvService };
  }

  it('a slow, later-failing rotation never revokes a DIFFERENT, already-persisted generation from a faster concurrent rotation for the same task, and the two never interleave', async () => {
    const { tokenRepo, paneEnvService } = makeServices();
    const server = makeServer();
    const task = makeTask({ id: 42 });
    const issuedTokenIds: number[] = [];
    const realBuild = paneEnvService.buildEnvForNewWindow.bind(paneEnvService);
    vi.spyOn(paneEnvService, 'buildEnvForNewWindow').mockImplementation((...args) => {
      const result = realBuild(...args);
      issuedTokenIds.push(result.tokenId);
      return result;
    });

    const gateSlow = makeGate<{ result: { stdout: string; stderr: string; code: number }; windowName: string }>();
    const order: string[] = [];

    // The "slow" rotation is queued first but its create() doesn't resolve
    // until the test releases the gate below — by construction (the lock),
    // the "fast" rotation cannot even START issuing its own generation until
    // the slow one's whole span (including its failure handling) is done.
    const slow = runExclusiveForTask(task.id, async () => {
      order.push('slow-start');
      const created = await createRotatedWindow(paneEnvService, server, task, 'slow_failed', async () => gateSlow.promise);
      order.push('slow-end');
      return created;
    }).catch((err: unknown) => err as Error);

    const fast = runExclusiveForTask(task.id, async () => {
      order.push('fast-start');
      const created = await createRotatedWindow(paneEnvService, server, task, 'fast_failed', async () => ({
        result: { stdout: '', stderr: '', code: 0 },
        windowName: 'fast-window',
      }));
      order.push('fast-end');
      return created;
    });

    // The fast rotation must not have started at all yet — it's queued
    // behind the slow one's still-open gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['slow-start']);

    // Now let the slow one fail (agent-transport non-zero exit).
    gateSlow.release({ result: { stdout: '', stderr: 'boom', code: 1 }, windowName: 'slow-window' });

    const slowResult = await slow;
    const fastResult = await fast;

    expect(order).toEqual(['slow-start', 'fast-start', 'fast-end']);
    expect(slowResult).toBeInstanceOf(Error);
    expect((slowResult as Error).message).toMatch(/Failed to create tmux window/);
    expect(fastResult.windowName).toBe('fast-window');
    expect(issuedTokenIds).toHaveLength(2);
    const [slowTokenId, fastTokenId] = issuedTokenIds;

    // The slow rotation's own generation was revoked by its own failure
    // handling inside createRotatedWindow...
    expect(tokenRepo.isActive(slowTokenId)).toBe(false);
    // ...but the fast rotation's generation, already created and returned
    // successfully, must still be active — a blanket revokeAllForTask from
    // the slow rotation's rollback (the pre-fix behavior) would have wiped
    // this out too, and running the two spans concurrently instead of under
    // runExclusiveForTask could have let the fast rotation's own issuance
    // revoke the slow one mid-flight (the interleaving the lock exists to
    // prevent).
    expect(tokenRepo.isActive(fastTokenId)).toBe(true);
  });

  it('rollbackWindowReference revokes only the tokenId it was given, not a concurrently-issued newer generation', async () => {
    const { tokenRepo, paneEnvService } = makeServices();
    const server = makeServer();
    const task = makeTask({ id: 43 });

    // Simulate: rotation A already succeeded and persisted (generation 1)...
    const a = await createRotatedWindow(paneEnvService, server, task, 'a_failed', async () => ({
      result: { stdout: '', stderr: '', code: 0 },
      windowName: 'a-window',
    }));
    // ...then a LATER rotation B is issued for the same task (generation 2,
    // which — per issueNextGeneration's contract — revokes generation 1 as
    // part of normal rotation, same as a real follow-up execute() would).
    const b = await createRotatedWindow(paneEnvService, server, task, 'b_failed', async () => ({
      result: { stdout: '', stderr: '', code: 0 },
      windowName: 'b-window',
    }));
    expect(tokenRepo.isActive(a.tokenId)).toBe(false); // superseded by b's issuance, as expected
    expect(tokenRepo.isActive(b.tokenId)).toBe(true);

    // Now B's OWN follow-up step fails (e.g. worktree creation) and rolls
    // B's specific generation back — this must never touch A's row (already
    // revoked, and irrelevant to B's rollback) nor pretend to touch "the
    // task's tokens" in general.
    await rollbackWindowReference(
      Promise.resolve({ stdout: '', stderr: '', code: 0 }),
      paneEnvService,
      b.tokenId,
      'b_rollback',
      () => {},
      () => {},
    );

    expect(tokenRepo.isActive(b.tokenId)).toBe(false);
  });
});

// Issue #28 third-party review, second round: `onGone` throwing (e.g. a DB
// write failing) previously skipped the revoke that follows it — the
// just-killed window's generation was left valid forever with nothing in
// the DB pointing at it. `rollbackWindowReference` must always attempt the
// revoke, and must still propagate `onGone`'s error to the caller (not
// swallow it).
describe('rollbackWindowReference: onGone throwing must not skip the revoke', () => {
  function makeServices() {
    const tokenRepo = new FakeTaskTokenRepo();
    const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []) } as any;
    const paneEnvService = new TaskPaneEnvironmentService(tokenRepo, projectSecretRepo, 'ui-token', true);
    return { tokenRepo, paneEnvService };
  }

  it('still revokes the generation, and propagates the error, when onGone throws', async () => {
    const { tokenRepo, paneEnvService } = makeServices();
    const server = makeServer();
    const task = makeTask({ id: 50 });

    const created = await createRotatedWindow(paneEnvService, server, task, 'unused', async () => ({
      result: { stdout: '', stderr: '', code: 0 },
      windowName: 'w',
    }));
    expect(tokenRepo.isActive(created.tokenId)).toBe(true);

    const onGone = vi.fn(() => {
      throw new Error('reference bookkeeping failed');
    });
    const onStillAlive = vi.fn();

    await expect(
      rollbackWindowReference(
        Promise.resolve({ stdout: '', stderr: '', code: 0 }),
        paneEnvService,
        created.tokenId,
        'kill_confirmed',
        onGone,
        onStillAlive,
      ),
    ).rejects.toThrow('reference bookkeeping failed');

    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onStillAlive).not.toHaveBeenCalled();
    // The critical assertion: despite onGone throwing, the revoke still ran.
    expect(tokenRepo.isActive(created.tokenId)).toBe(false);
  });

  // Issue #28 third-party review, D-track fix 4: a plain `try { onGone() }
  // finally { revoke() }` lets a revoke failure REPLACE onGone's error (a
  // `finally` block's own throw always wins) — the caller's real domain
  // failure (e.g. a DB write) was silently lost behind an unrelated revoke
  // error. Both must be attempted independently, and onGone's error must be
  // the one that propagates.
  it('propagates onGone\'s error (not the revoke\'s) when BOTH onGone and the revoke fail', async () => {
    const { tokenRepo, paneEnvService } = makeServices();
    const server = makeServer();
    const task = makeTask({ id: 51 });

    const created = await createRotatedWindow(paneEnvService, server, task, 'unused', async () => ({
      result: { stdout: '', stderr: '', code: 0 },
      windowName: 'w',
    }));

    const onGone = vi.fn(() => {
      throw new Error('reference bookkeeping failed');
    });
    const onStillAlive = vi.fn();
    const revokeSpy = vi.spyOn(paneEnvService, 'revokeGeneration').mockImplementation(() => {
      throw new Error('revoke transport failed');
    });

    let thrown: unknown;
    try {
      await rollbackWindowReference(
        Promise.resolve({ stdout: '', stderr: '', code: 0 }),
        paneEnvService,
        created.tokenId,
        'kill_confirmed',
        onGone,
        onStillAlive,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('reference bookkeeping failed');
    expect(onGone).toHaveBeenCalledTimes(1);
    // The revoke was still attempted despite onGone having already failed.
    expect(revokeSpy).toHaveBeenCalledWith(created.tokenId, 'kill_confirmed');
    expect(onStillAlive).not.toHaveBeenCalled();
    // Issue #28 third-party review, follow-up (batch-2) fix: the doc comment
    // promises the revoke error is attached as onGone's error's `cause` when
    // both fail — verify it structurally, not just via a console.warn.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as Error).message).toBe('revoke transport failed');
  });

  // Follow-up fix (Issue #28 batch review): a prior version of this function
  // made a lone revoke failure log-only when `onGone` succeeded, so the
  // whole call reported success even though the just-killed window's token
  // generation was still live. A standalone revoke failure must now
  // propagate to the caller just like a standalone onGone failure does.
  it('propagates the revoke error when the revoke ALONE fails (onGone succeeds)', async () => {
    const { paneEnvService } = makeServices();
    const server = makeServer();
    const task = makeTask({ id: 52 });

    const created = await createRotatedWindow(paneEnvService, server, task, 'unused', async () => ({
      result: { stdout: '', stderr: '', code: 0 },
      windowName: 'w',
    }));

    const onGone = vi.fn();
    const onStillAlive = vi.fn();
    const revokeSpy = vi.spyOn(paneEnvService, 'revokeGeneration').mockImplementation(() => {
      throw new Error('revoke transport failed');
    });

    await expect(
      rollbackWindowReference(
        Promise.resolve({ stdout: '', stderr: '', code: 0 }),
        paneEnvService,
        created.tokenId,
        'kill_confirmed',
        onGone,
        onStillAlive,
      ),
    ).rejects.toThrow('revoke transport failed');

    expect(onGone).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith(created.tokenId, 'kill_confirmed');
    expect(onStillAlive).not.toHaveBeenCalled();
  });
});
