import { describe, it, expect } from 'vitest';
import { checkExecutionGate, hashApprovedTaskFingerprint } from './ExecutionGate';
import type { Task } from '../Task';
import type { ProjectServer } from '../../projects/ProjectServer';

// Second-round review finding (Issue #328): hashing task.description alone
// let a human's approval survive a post-approval rewrite of task.title, even
// though title also reaches the worker's prompt (resolveTaskPromptVars.ts).
// These tests pin the fix: the approval fingerprint must invalidate on ANY
// prompt-reaching field edit, not just description.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Original title',
    description: 'Original description',
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
    inputTrust: 'untrusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const manualApprovalServer: ProjectServer = {
  projectId: 10,
  serverName: 'test-server',
  workingDirectory: '/work',
  branch: 'main',
  tmuxSession: 'azito',
  inputPolicy: 'manual-approval',
};

describe('hashApprovedTaskFingerprint / checkExecutionGate (Issue #328 second-round fix)', () => {
  it('an approval survives re-checking the SAME task unchanged', () => {
    const task = makeTask();
    task.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(task);

    expect(checkExecutionGate(task, manualApprovalServer)).toEqual({ allowed: true });
  });

  it('editing ONLY title after approval invalidates the approval (the bug this fix closes)', () => {
    const approved = makeTask();
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const editedTitle = { ...approved, title: 'Attacker-controlled new title' };

    expect(checkExecutionGate(editedTitle, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing ONLY description after approval invalidates the approval', () => {
    const approved = makeTask();
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const editedDescription = { ...approved, description: 'Attacker-controlled new description' };

    expect(checkExecutionGate(editedDescription, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing targetBranch after approval invalidates the approval (also reaches the prompt)', () => {
    const approved = makeTask({ targetBranch: 'release/1.0' });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, targetBranch: 'release/evil' };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing baseBranch after approval invalidates the approval (also reaches the prompt via project.defaultBranch)', () => {
    const approved = makeTask({ baseBranch: 'main' });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, baseBranch: 'evil-base' };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing workingDirectory after approval invalidates the approval (also reaches the prompt)', () => {
    const approved = makeTask({ workingDirectory: '/srv/app' });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, workingDirectory: '/srv/evil' };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('field-boundary shift between title and description does not falsely collide with a prior approval', () => {
    // Guards against a naive string-concatenation fingerprint: moving text
    // across the title/description boundary must NOT produce the same hash.
    const a = makeTask({ title: 'AB', description: 'CD' });
    const b = makeTask({ title: 'A', description: 'BCD' });

    expect(hashApprovedTaskFingerprint(a)).not.toBe(hashApprovedTaskFingerprint(b));
  });

  it('editing an unrelated field (e.g. priority) does NOT invalidate the approval', () => {
    const approved = makeTask({ priority: 0 });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, priority: 5 };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: true });
  });
});

// Third-round review finding 1 (Issue #328): PUT /api/tasks/:id also lets a
// client freely edit unitId/serverName/branch/reviewSubagent/implementSubagent
// with no inputTrust restriction. unitId/serverName/branch pick a different
// Unit/host/branch than the one a human approved; reviewSubagent/
// implementSubagent's provider/model are interpolated directly into a
// delegated subagent's launch instructions. Each must independently
// invalidate a prior approval.
describe('hashApprovedTaskFingerprint / checkExecutionGate (Issue #328 third-round fix: targeting fields)', () => {
  it('editing unitId after approval invalidates the approval (changes WHAT Unit runs it)', () => {
    const approved = makeTask({ unitId: 20 });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, unitId: 999 };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing serverName after approval invalidates the approval (changes WHERE it runs, and which input_policy row applies)', () => {
    const approved = makeTask({ serverName: 'test-server' });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, serverName: 'other-server' };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing branch after approval invalidates the approval (changes which existing branch is checked out)', () => {
    const approved = makeTask({ branch: 'task/1-original' });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, branch: 'task/1-attacker' };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing reviewSubagent after approval invalidates the approval (provider/model reach a delegated subagent prompt)', () => {
    const approved = makeTask({ reviewSubagent: { enabled: true, provider: 'claude', model: 'sonnet' } });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, reviewSubagent: { enabled: true, provider: 'attacker-provider', model: 'attacker-model' } };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing implementSubagent after approval invalidates the approval', () => {
    const approved = makeTask({ implementSubagent: { enabled: true, provider: 'claude', model: 'sonnet' } });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, implementSubagent: { enabled: true, provider: 'attacker-provider', model: 'attacker-model' } };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('editing worktreePath after approval does NOT invalidate the approval (system-overwritten on every run; see ExecutionGate.ts ApprovableTaskFields doc)', () => {
    const approved = makeTask({ worktreePath: null });
    approved.executionApprovedFingerprintHash = hashApprovedTaskFingerprint(approved);

    const edited = { ...approved, worktreePath: '/work/.worktrees/task-1' };

    expect(checkExecutionGate(edited, manualApprovalServer)).toEqual({ allowed: true });
  });
});
