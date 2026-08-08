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

// recordExecutionGateBlock() (Issue #328 review round, fix 1 + fix 2): the
// compare-and-swap counterpart to consumePendingApproval() above. These tests
// exercise the REAL SQL (not a mock) for the SAME reason the suite above
// does — the guard being tested lives entirely in the WHERE clause.

describe('SqliteTaskRepository.recordExecutionGateBlock (Issue #328 review round)', () => {
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
      status: 'review',
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
      pendingOperation: null,
      pendingOperationWindowId: null,
      pendingOperationPriorStatus: null,
    });
    // create() always inserts status = the schema default ('open') — set it
    // directly to reach the 'review' state these tests need as the "real
    // prior status" a block should record.
    repo.updateStatus(taskId, 'review');
  });

  it('records the block: status -> pending_approval, pendingOperation/priorStatus persisted', () => {
    const recorded = repo.recordExecutionGateBlock(taskId, {
      pendingOperation: 'execute',
      priorStatus: 'review',
      manifestHash: 'hash-a',
    });

    expect(recorded).toBe(true);
    const task = repo.findById(taskId);
    expect(task?.status).toBe('pending_approval');
    expect(task?.pendingOperation).toBe('execute');
    expect(task?.pendingOperationPriorStatus).toBe('review');
    expect(task?.pendingOperationWindowId).toBeNull();
  });

  it('folds pendingOperationWindowId into the SAME atomic write for a respawn block (Issue #328 review round fix 1)', () => {
    const recorded = repo.recordExecutionGateBlock(taskId, {
      pendingOperation: 'respawn',
      priorStatus: 'review',
      manifestHash: 'hash-a',
      pendingOperationWindowId: 42,
    });

    expect(recorded).toBe(true);
    expect(repo.findById(taskId)?.pendingOperationWindowId).toBe(42);
  });

  it('a SECOND block attempt (a concurrently-blocked entry point) is rejected while the first is still outstanding — the compare-and-swap affects zero rows', () => {
    const first = repo.recordExecutionGateBlock(taskId, { pendingOperation: 'execute', priorStatus: 'review', manifestHash: 'hash-a' });
    const second = repo.recordExecutionGateBlock(taskId, { pendingOperation: 'resume', priorStatus: 'pending_approval', manifestHash: 'hash-b' });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The SECOND (losing) call's operation/windowId must not have overwritten
    // the first's — this is the actual harm a non-atomic read-then-write
    // would cause (Issue #328 review round finding this method exists to fix
    // in TaskRestoreService/WindowRespawnService, which used to call the
    // generic `update()` here instead).
    const task = repo.findById(taskId);
    expect(task?.pendingOperation).toBe('execute');
    expect(task?.pendingOperationPriorStatus).toBe('review');
  });

  it('is rejected once a concurrent approval already matches the manifest hash the block was evaluated against (Issue #328 review round fix 2 — closes the approval-rewind race)', () => {
    // Simulates: request A evaluated the gate against `hash-a` and decided it
    // needed to block; meanwhile a human concurrently approved the SAME
    // manifest (hash-a), so execution_approved_fingerprint_hash is now
    // exactly the hash A's block would be stale against. A's late write must
    // not rewind the just-approved task back to pending_approval.
    repo.update(taskId, { executionApprovedFingerprintHash: 'hash-a' });

    const recorded = repo.recordExecutionGateBlock(taskId, {
      pendingOperation: 'execute',
      priorStatus: 'review',
      manifestHash: 'hash-a',
    });

    expect(recorded).toBe(false);
    const task = repo.findById(taskId);
    expect(task?.status).toBe('review');
    expect(task?.pendingOperation).toBeNull();
  });

  it('still succeeds when the approved fingerprint differs from the manifest hash being blocked (a real, still-unapproved drift)', () => {
    repo.update(taskId, { executionApprovedFingerprintHash: 'some-older-hash' });

    const recorded = repo.recordExecutionGateBlock(taskId, {
      pendingOperation: 'execute',
      priorStatus: 'review',
      manifestHash: 'hash-a',
    });

    expect(recorded).toBe(true);
    expect(repo.findById(taskId)?.status).toBe('pending_approval');
  });

  it("refuses to write (and returns false) when the caller's priorStatus snapshot is already 'pending_approval' — a self-referential value that would make an eventual approval restore the task right back to pending_approval (Issue #328 review round fix 2, defensive guard)", () => {
    const recorded = repo.recordExecutionGateBlock(taskId, {
      pendingOperation: 'execute',
      priorStatus: 'pending_approval',
      manifestHash: 'hash-a',
    });

    expect(recorded).toBe(false);
    // Nothing was written — status stays whatever it was before this call
    // (not forced into pending_approval by a rejected write).
    expect(repo.findById(taskId)?.status).toBe('review');
    expect(repo.findById(taskId)?.pendingOperation).toBeNull();
  });

  it("is rejected when the task's status has already moved on from the caller's stale priorStatus snapshot (e.g. archived concurrently) — the guarded UPDATE must compare current status, not just overwrite it (Issue #328 review round, status-CAS fix)", () => {
    // request A read the task while it was 'review' and is about to block it.
    // Before A's write lands, a concurrent request archives the task —
    // status is no longer what A observed.
    repo.updateStatus(taskId, 'archived');

    const recorded = repo.recordExecutionGateBlock(taskId, {
      pendingOperation: 'execute',
      priorStatus: 'review', // A's stale snapshot — no longer the real status
      manifestHash: 'hash-a',
    });

    expect(recorded).toBe(false);
    // Without the status = ? guard in the WHERE clause, this write would
    // succeed and overwrite 'archived' with 'pending_approval', resurrecting
    // an archived task — and a later approval would restore it to 'review'
    // (A's stale priorStatus), letting it execute again.
    const task = repo.findById(taskId);
    expect(task?.status).toBe('archived');
    expect(task?.pendingOperation).toBeNull();
    expect(task?.pendingOperationPriorStatus).toBeNull();
  });
});

// preApproveExecution() (task/328 follow-up — creation-time pre-approval):
// the compare-and-swap counterpart used by decideExecutionPreApproval(),
// guarded on status='open' AND pending_operation IS NULL AND
// input_trust='untrusted' — a task outside that narrow window (already
// gate-blocked, already progressed, or trusted) must not be writable through
// this shortcut.
describe('SqliteTaskRepository.preApproveExecution (task/328 follow-up)', () => {
  let db: SqliteDatabase;
  let repo: SqliteTaskRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteTaskRepository(db);
    db.prepare(
      "INSERT INTO projects (id, name, slug, default_branch) VALUES (1, 'P', 'p', 'main')",
    ).run();
  });

  function createTask(overrides: { inputTrust?: 'trusted' | 'untrusted'; pendingOperation?: 'execute' | null } = {}): number {
    return repo.create({
      projectId: 1,
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
      inputTrust: overrides.inputTrust ?? 'untrusted',
      executionApprovedFingerprintHash: null,
      pendingOperation: overrides.pendingOperation ?? null,
      pendingOperationWindowId: null,
      pendingOperationPriorStatus: null,
    });
  }

  it('writes the fingerprint and leaves status/pendingOperation untouched for a fresh open untrusted task', () => {
    const taskId = createTask();

    const written = repo.preApproveExecution(taskId, 'hash-abc');

    expect(written).toBe(true);
    const task = repo.findById(taskId);
    expect(task?.executionApprovedFingerprintHash).toBe('hash-abc');
    expect(task?.status).toBe('open');
    expect(task?.pendingOperation).toBeNull();
  });

  it('refuses to write for a trusted task — nothing to pre-approve', () => {
    const taskId = createTask({ inputTrust: 'trusted' });

    const written = repo.preApproveExecution(taskId, 'hash-abc');

    expect(written).toBe(false);
    expect(repo.findById(taskId)?.executionApprovedFingerprintHash).toBeNull();
  });

  it('refuses to write once the task has already been gate-blocked (pendingOperation set) — the normal pending_approval panel owns it now', () => {
    const taskId = createTask({ pendingOperation: 'execute' });
    repo.updateStatus(taskId, 'pending_approval');

    const written = repo.preApproveExecution(taskId, 'hash-abc');

    expect(written).toBe(false);
    expect(repo.findById(taskId)?.executionApprovedFingerprintHash).toBeNull();
  });

  it('refuses a second call once the fingerprint has already been recorded once and the task has moved past open', () => {
    const taskId = createTask();
    expect(repo.preApproveExecution(taskId, 'hash-abc')).toBe(true);
    repo.updateStatus(taskId, 'running');

    const secondWrite = repo.preApproveExecution(taskId, 'hash-def');

    expect(secondWrite).toBe(false);
    // First write's value survives untouched.
    expect(repo.findById(taskId)?.executionApprovedFingerprintHash).toBe('hash-abc');
  });
});
