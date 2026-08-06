import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../shared/db/Database';
import { SqliteTaskRepository } from './SqliteTaskRepository';

// consumePendingApproval() (Issue #328 ninth-round review finding 4): the
// approve-execution route used to clear pendingOperation via the generic
// update() (read-then-write, no guard), so a double-submitted approval could
// both pass the route's own status check and each independently dispatch an
// operation — the second reading pendingOperation/pendingOperationWindowId
// the first had already started acting on. These tests exercise the REAL
// SQL (not a mock) to prove the guarded UPDATE is what actually enforces
// "only the first caller wins", using better-sqlite3 against an in-memory DB
// migrated the same way production is (openDatabase runs the full chain).

describe('SqliteTaskRepository.consumePendingApproval (Issue #328 ninth-round review finding 4)', () => {
  let db: SqliteDatabase;
  let repo: SqliteTaskRepository;
  let taskId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteTaskRepository(db);
    db.prepare(
      "INSERT INTO projects (id, name, slug, default_branch) VALUES (1, 'P', 'p', 'main')",
    ).run();
    taskId = repo.create({
      projectId: 1,
      unitId: null,
      serverName: null,
      title: 'Test task',
      description: null,
      status: 'pending_approval',
      currentPhase: null,
      selfReviewCount: 0,
      priority: 0,
      tmuxWindow: null,
      selfReviewMaxAttempts: null,
      requirePlanApproval: true,
      source: 'github',
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
      reviewSubagent: null,
      implementSubagent: null,
      inputTrust: 'untrusted',
      executionApprovedFingerprintHash: null,
      pendingOperation: 'execute',
      pendingOperationWindowId: null,
      pendingOperationPriorStatus: 'open',
    });
    // create() doesn't accept `status` (it's always inserted as the
    // schema's 'open' default) — set it directly to reach the
    // 'pending_approval' state these tests need.
    repo.updateStatus(taskId, 'pending_approval');
  });

  it('the first call consumes the pending approval and clears the bookkeeping fields', () => {
    const consumed = repo.consumePendingApproval(taskId, { executionApprovedFingerprintHash: 'abc123' });

    expect(consumed).toBe(true);
    const task = repo.findById(taskId);
    expect(task?.executionApprovedFingerprintHash).toBe('abc123');
    expect(task?.pendingOperation).toBeNull();
    expect(task?.pendingOperationWindowId).toBeNull();
    expect(task?.pendingOperationPriorStatus).toBeNull();
    // consumePendingApproval only touches the fields it's asked to plus the
    // pending-approval bookkeeping — status is untouched here (the approve
    // path's per-operation dispatch sets it afterward via updateStatus()).
    expect(task?.status).toBe('pending_approval');
  });

  it('a SECOND call for the same task (double-submitted approval) is rejected — the compare-and-clear affects zero rows', () => {
    const first = repo.consumePendingApproval(taskId, { executionApprovedFingerprintHash: 'abc123' });
    const second = repo.consumePendingApproval(taskId, { executionApprovedFingerprintHash: 'should-not-apply' });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The second call's fingerprint must NOT have overwritten the first's —
    // this is the actual harm a non-atomic double-consume would cause.
    expect(repo.findById(taskId)?.executionApprovedFingerprintHash).toBe('abc123');
  });

  it('a double-submitted DENIAL is likewise rejected on the second call', () => {
    const first = repo.consumePendingApproval(taskId, { status: 'failed' });
    const second = repo.consumePendingApproval(taskId, { status: 'archived' });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The second (losing) call's status must not have overwritten the first's.
    expect(repo.findById(taskId)?.status).toBe('failed');
  });

  it('does nothing when the task is not pending_approval (already resolved, or never blocked)', () => {
    repo.updateStatus(taskId, 'open');

    const consumed = repo.consumePendingApproval(taskId, { executionApprovedFingerprintHash: 'abc123' });

    expect(consumed).toBe(false);
    expect(repo.findById(taskId)?.executionApprovedFingerprintHash).toBeNull();
  });

  it('does nothing when pendingOperation is already NULL (nothing left to consume)', () => {
    repo.update(taskId, { pendingOperation: null, pendingOperationWindowId: null, pendingOperationPriorStatus: null });

    const consumed = repo.consumePendingApproval(taskId, { executionApprovedFingerprintHash: 'abc123' });

    expect(consumed).toBe(false);
  });
});
