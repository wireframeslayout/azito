import { describe, it, expect, vi } from 'vitest';
import { TaskOriginationService, type TaskOriginationFields } from './TaskOriginationService';
import type { ITaskRepository } from '../Task';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';

function baseFields(overrides: Partial<TaskOriginationFields> = {}): TaskOriginationFields {
  return {
    projectId: 1,
    unitId: null,
    serverName: null,
    title: 'A task',
    description: null,
    status: 'open',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: true,
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
    reviewSubagent: null,
    implementSubagent: null,
    sleepAfterPush: null,
    executionApprovedFingerprintHash: null,
    pendingOperation: null,
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: null,
    ...overrides,
  };
}

function makeService() {
  const taskRepo = { create: vi.fn(() => 99) } as unknown as ITaskRepository;
  const auditLogService = { record: vi.fn() } as unknown as AuditLogService;
  const service = new TaskOriginationService(taskRepo, auditLogService);
  return { service, taskRepo, auditLogService };
}

describe('TaskOriginationService.create', () => {
  it('trusts an operator-originated, source=local task', () => {
    const { service, taskRepo } = makeService();
    service.create(baseFields({ source: 'local' }), { kind: 'operator', id: null }, { class: 'operator' });

    expect(taskRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      inputTrust: 'trusted', createdByKind: 'operator', createdById: null,
    }));
  });

  it('does not trust an operator-originated task imported from github', () => {
    const { service, taskRepo } = makeService();
    service.create(baseFields({ source: 'github' }), { kind: 'operator', id: null }, { class: 'operator' });

    expect(taskRepo.create).toHaveBeenCalledWith(expect.objectContaining({ inputTrust: 'untrusted' }));
  });

  it('never trusts a task-originated child, even with source=local', () => {
    const { service, taskRepo } = makeService();
    service.create(baseFields({ source: 'local' }), { kind: 'task', id: 7 }, { class: 'task', id: 7 });

    expect(taskRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      inputTrust: 'untrusted', createdByKind: 'task', createdById: 7,
    }));
  });

  it('never trusts a trigger- or system-originated task', () => {
    const { service, taskRepo } = makeService();
    service.create(baseFields({ source: 'local' }), { kind: 'trigger', id: 3 }, { class: 'trigger', id: 3 });
    expect(taskRepo.create).toHaveBeenCalledWith(expect.objectContaining({ inputTrust: 'untrusted', createdByKind: 'trigger' }));

    service.create(baseFields({ source: 'local' }), { kind: 'system', id: null }, { class: 'runtime' });
    expect(taskRepo.create).toHaveBeenCalledWith(expect.objectContaining({ inputTrust: 'untrusted', createdByKind: 'system' }));
  });

  it('records an audit log entry with the resolved id, origin, and inputTrust', () => {
    const { service, auditLogService } = makeService();
    service.create(baseFields(), { kind: 'operator', id: null }, { class: 'operator' });

    expect(auditLogService.record).toHaveBeenCalledWith({
      actorClass: 'operator',
      actorId: null,
      event: 'task.created',
      detail: { taskId: 99, createdByKind: 'operator', createdById: null, source: 'local', inputTrust: 'trusted' },
    });
  });

  it('returns the id taskRepo.create() produced', () => {
    const { service } = makeService();
    const id = service.create(baseFields(), { kind: 'operator', id: null }, { class: 'operator' });
    expect(id).toBe(99);
  });

  // Issue #28 third-party review finding 3: audit-log failure must not fail
  // task creation (a caller retrying on an error response after the task
  // ALREADY committed would create a duplicate task).
  it('returns the created id (as a success) even when the audit log write throws', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const taskRepo = { create: vi.fn(() => 99) } as unknown as ITaskRepository;
      const auditLogService = { record: vi.fn(() => { throw new Error('audit db unavailable'); }) } as unknown as AuditLogService;
      const service = new TaskOriginationService(taskRepo, auditLogService);

      const id = service.create(baseFields(), { kind: 'operator', id: null }, { class: 'operator' });

      expect(id).toBe(99);
      expect(taskRepo.create).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
