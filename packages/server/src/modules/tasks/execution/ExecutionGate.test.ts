import { describe, it, expect } from 'vitest';
import { checkExecutionGate } from './ExecutionGate';
import type { Task } from '../Task';
import type { ProjectServer } from '../../projects/ProjectServer';

// checkExecutionGate() is a pure comparator (Issue #328 fifth-round review):
// it takes an already-resolved manifest hash and never resolves or hashes
// anything itself — that work moved to ExecutionManifest.ts, which has its
// own test file (ExecutionManifest.test.ts) covering what's included in the
// hash and why. These tests only cover the comparator's own decision table:
// trusted tasks bypass the gate entirely, policy short-circuits before any
// hash comparison, and manual-approval compares the stored hash against
// whatever hash the caller resolved.

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
    pendingOperationWindowId: null,
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

const denyServer: ProjectServer = { ...manualApprovalServer, inputPolicy: 'deny' };
const allowServer: ProjectServer = { ...manualApprovalServer, inputPolicy: 'allow' };

describe('checkExecutionGate', () => {
  it('a trusted task is always allowed, regardless of policy or hash', () => {
    const task = makeTask({ inputTrust: 'trusted', executionApprovedFingerprintHash: null });
    expect(checkExecutionGate(task, denyServer, 'any-hash')).toEqual({ allowed: true });
  });

  it('an untrusted task under "deny" policy is denied even with a matching hash', () => {
    const task = makeTask({ inputTrust: 'untrusted', executionApprovedFingerprintHash: 'abc' });
    expect(checkExecutionGate(task, denyServer, 'abc')).toEqual({ allowed: false, reason: 'denied' });
  });

  it('an untrusted task under "allow" policy is allowed without a stored hash', () => {
    const task = makeTask({ inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    expect(checkExecutionGate(task, allowServer, 'anything')).toEqual({ allowed: true });
  });

  it('an untrusted task under "manual-approval" is allowed when the stored hash matches the current one', () => {
    const task = makeTask({ inputTrust: 'untrusted', executionApprovedFingerprintHash: 'matching-hash' });
    expect(checkExecutionGate(task, manualApprovalServer, 'matching-hash')).toEqual({ allowed: true });
  });

  it('an untrusted task under "manual-approval" requires approval when the hash differs (edit invalidated it)', () => {
    const task = makeTask({ inputTrust: 'untrusted', executionApprovedFingerprintHash: 'stale-hash' });
    expect(checkExecutionGate(task, manualApprovalServer, 'fresh-hash')).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('an untrusted task under "manual-approval" with no stored hash requires approval', () => {
    const task = makeTask({ inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    expect(checkExecutionGate(task, manualApprovalServer, 'any-hash')).toEqual({ allowed: false, reason: 'pending_approval' });
  });

  it('a missing project_servers row defaults to manual-approval (fail-safe, not fail-open)', () => {
    const task = makeTask({ inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    expect(checkExecutionGate(task, null, 'any-hash')).toEqual({ allowed: false, reason: 'pending_approval' });
  });
});
