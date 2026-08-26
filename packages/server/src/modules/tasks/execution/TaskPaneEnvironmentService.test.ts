import { describe, it, expect, vi } from 'vitest';
import { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';
import type { ITaskTokenRepository } from '../tokens/TaskToken';
import type { Task } from '../Task';
import type { ServerConfig } from '../../servers/Server';
import { ISOLATION_MASKED_ENV } from '../../../shared/auth/isolationMaskedEnv';

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
    isolationReport: null, isolationCleanupReport: null,
    muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDeps(scopedAuthEnabled: boolean) {
  const taskTokenRepo: Pick<ITaskTokenRepository, 'issueNextGeneration' | 'revokeAllForTask' | 'revoke'> = {
    issueNextGeneration: vi.fn(() => ({ id: 1, token: 'azt.task.1.' + 'a'.repeat(64) })),
    revokeAllForTask: vi.fn(() => 1),
    revoke: vi.fn(() => 1),
  };
  const projectSecretRepo = {
    findByProjectWithValues: vi.fn(() => [{ id: 1, projectId: 7, name: 'FOO', value: 'bar', createdAt: '', updatedAt: '' }]),
  };
  const auditLogService = { record: vi.fn() };
  const service = new TaskPaneEnvironmentService(
    taskTokenRepo as ITaskTokenRepository, projectSecretRepo as any, 'ui-token-123', scopedAuthEnabled, auditLogService as any,
  );
  return { service, taskTokenRepo, projectSecretRepo, auditLogService };
}

describe('TaskPaneEnvironmentService.buildEnvForNewWindow', () => {
  it('always sets AZITO_TASK_TOKEN/AZITO_TASK_ID and project secrets, rotating via issueNextGeneration, and returns the issued row id as tokenId', () => {
    const { service, taskTokenRepo } = makeDeps(false);
    const { env, tokenId } = service.buildEnvForNewWindow(makeTask({ id: 5, projectId: 7 }), makeServer());

    expect(taskTokenRepo.issueNextGeneration).toHaveBeenCalledWith(5, 'window_regenerated');
    expect(env.AZITO_TASK_TOKEN).toMatch(/^azt\.task\.1\./);
    expect(env.AZITO_TASK_ID).toBe('5');
    expect(env.AZITO_SECRET_FOO).toBe('bar');
    expect(tokenId).toBe(1);
  });

  it('injects AZITO_UI_TOKEN when the scoped-auth flag is off (compat mode)', () => {
    const { service } = makeDeps(false);
    const { env } = service.buildEnvForNewWindow(makeTask(), makeServer());
    expect(env.AZITO_UI_TOKEN).toBe('ui-token-123');
  });

  // Issue #29 Step 1: buildEnvForNewWindow is the single credential-injection
  // point every execute/restore/respawn/recovery/splitPane path funnels
  // through — this is the one place isolation_intent must actually withhold
  // project secrets from a server declared to hold none.
  it('withholds AZITO_SECRET_* entirely for a server with isolationIntent=true', () => {
    const { service, projectSecretRepo } = makeDeps(false);
    const { env } = service.buildEnvForNewWindow(makeTask(), makeServer({ isolationIntent: true }));

    expect(env.AZITO_SECRET_FOO).toBeUndefined();
    expect(Object.keys(env).some((k) => k.startsWith('AZITO_SECRET_'))).toBe(false);
    // Not just filtered post-read — never even decrypted.
    expect(projectSecretRepo.findByProjectWithValues).not.toHaveBeenCalled();
  });

  it('still injects project secrets for a server with isolationIntent=false (default/unset)', () => {
    const { service } = makeDeps(false);
    const { env } = service.buildEnvForNewWindow(makeTask(), makeServer({ isolationIntent: false }));
    expect(env.AZITO_SECRET_FOO).toBe('bar');
  });

  it('still issues/rotates the task token for an isolated server (isolation only withholds secrets, not the task token)', () => {
    const { service, taskTokenRepo } = makeDeps(false);
    const { env } = service.buildEnvForNewWindow(makeTask({ id: 9 }), makeServer({ isolationIntent: true }));
    expect(taskTokenRepo.issueNextGeneration).toHaveBeenCalledWith(9, 'window_regenerated');
    expect(env.AZITO_TASK_TOKEN).toMatch(/^azt\.task\.1\./);
  });

  it('explicitly overrides AZITO_UI_TOKEN to empty when the scoped-auth flag is on', () => {
    // Issue #28 third-party review finding (Critical): an explicit empty
    // override, not just omission, is required — tmux `new-window -e` only
    // masks a key a new pane would otherwise inherit from the tmux
    // SESSION's environment if this call actually sets that key itself.
    // Merely never assigning AZITO_UI_TOKEN here would leave a task pane
    // exposed to whatever the session's own environment happens to carry
    // (e.g. a project session created with `tmux.uiTokenEnv()`).
    const { service } = makeDeps(true);
    const { env } = service.buildEnvForNewWindow(makeTask(), makeServer());
    expect(env.AZITO_UI_TOKEN).toBe('');
  });

  it('injects AZITO_AGENT_TOKEN/AZITO_AGENT_PORT for an agent server only when the flag is off, and explicitly blanks AZITO_AGENT_TOKEN when on', () => {
    const agentServer = makeServer({ type: 'agent', agentPort: 4001, agentToken: 'secret-agent-token' });

    const off = makeDeps(false);
    const { env: envOff } = off.service.buildEnvForNewWindow(makeTask(), agentServer);
    expect(envOff.AZITO_AGENT_TOKEN).toBe('secret-agent-token');
    expect(envOff.AZITO_AGENT_PORT).toBe('4001');

    const on = makeDeps(true);
    const { env: envOn } = on.service.buildEnvForNewWindow(makeTask(), agentServer);
    expect(envOn.AZITO_AGENT_TOKEN).toBe('');
    expect(envOn.AZITO_AGENT_PORT).toBeUndefined();
  });

  it('never injects AZITO_AGENT_TOKEN for a local server even in compat mode', () => {
    const { service } = makeDeps(false);
    const { env } = service.buildEnvForNewWindow(makeTask(), makeServer({ type: 'local' }));
    expect(env.AZITO_AGENT_TOKEN).toBeUndefined();
  });

  // Issue #29 review, Critical finding 1: isolation must win over compat
  // mode. Compat mode (scopedAuthEnabled=false) is the hub's DEFAULT — before
  // this fix, an isolated server still received the full-power hub UI token
  // (and, for an agent-type server, the hub<->agent-server token) under that
  // default, exactly the credential isolation_intent declares the server
  // should hold none of.
  it('masks AZITO_UI_TOKEN/AZITO_AGENT_TOKEN to empty for an isolated agent server even in compat mode', () => {
    const { service } = makeDeps(false);
    const isolatedAgent = makeServer({ type: 'agent', agentPort: 4001, agentToken: 'secret-agent-token', isolationIntent: true });
    const { env } = service.buildEnvForNewWindow(makeTask(), isolatedAgent);

    expect(env.AZITO_UI_TOKEN).toBe('');
    expect(env.AZITO_AGENT_TOKEN).toBe('');
    expect(env.AZITO_AGENT_PORT).toBeUndefined();
  });

  it('masks AZITO_UI_TOKEN to empty for an isolated local server in compat mode', () => {
    const { service } = makeDeps(false);
    const { env } = service.buildEnvForNewWindow(makeTask(), makeServer({ type: 'local', isolationIntent: true }));
    expect(env.AZITO_UI_TOKEN).toBe('');
  });

  it('masks tokens for an isolated server even when scoped auth is also on', () => {
    const { service } = makeDeps(true);
    const isolatedAgent = makeServer({ type: 'agent', agentPort: 4001, agentToken: 'secret-agent-token', isolationIntent: true });
    const { env } = service.buildEnvForNewWindow(makeTask(), isolatedAgent);

    expect(env.AZITO_UI_TOKEN).toBe('');
    expect(env.AZITO_AGENT_TOKEN).toBe('');
  });

  // Issue #29 review (final pass), Critical finding 1: `uiTokenEnvForServer`
  // (TmuxClient) and this method's isolation mask must never drift apart —
  // both now read from the single shared ISOLATION_MASKED_ENV constant.
  // Asserted directly here (rather than only checking individual keys above)
  // so a future edit to either module's mask, without touching the other,
  // fails this test instead of silently reopening the gap.
  it('masks the isolated agent-server keys with exactly ISOLATION_MASKED_ENV (single source shared with TmuxClient)', () => {
    const { service } = makeDeps(false);
    const isolatedAgent = makeServer({ type: 'agent', agentPort: 4001, agentToken: 'secret-agent-token', isolationIntent: true });
    const { env } = service.buildEnvForNewWindow(makeTask(), isolatedAgent);

    for (const [key, value] of Object.entries(ISOLATION_MASKED_ENV)) {
      expect(env[key]).toBe(value);
    }
  });

  // Third-party review finding (Important): secrets must be read BEFORE the
  // token is rotated, so a decrypt/read failure never leaves the previous
  // generation revoked with no new generation ever issued (or returned to
  // the caller to roll back).
  it('reads project secrets before rotating the token (call order)', () => {
    const { service, taskTokenRepo, projectSecretRepo } = makeDeps(false);
    const calls: string[] = [];
    (projectSecretRepo.findByProjectWithValues as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('secrets');
      return [{ id: 1, projectId: 7, name: 'FOO', value: 'bar', createdAt: '', updatedAt: '' }];
    });
    (taskTokenRepo.issueNextGeneration as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('rotate');
      return { id: 1, token: 'azt.task.1.' + 'a'.repeat(64) };
    });

    service.buildEnvForNewWindow(makeTask(), makeServer());

    expect(calls).toEqual(['secrets', 'rotate']);
  });

  it('does not rotate (revoke the previous generation) when reading secrets throws', () => {
    const { service, taskTokenRepo, projectSecretRepo } = makeDeps(false);
    (projectSecretRepo.findByProjectWithValues as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('decrypt failed: master key mismatch');
    });

    expect(() => service.buildEnvForNewWindow(makeTask(), makeServer())).toThrow(/decrypt failed/);
    expect(taskTokenRepo.issueNextGeneration).not.toHaveBeenCalled();
  });

  // Issue #28 third-party review Important finding: the audit UI's own
  // description claims task-token issuance as a category it shows, but
  // nothing ever recorded it — this is the sole write path (issueNextGeneration)
  // for a (re)created window's token.
  it('records a task_token.issued audit event with the generation id but never the plaintext token', () => {
    const { service, auditLogService } = makeDeps(false);
    service.buildEnvForNewWindow(makeTask({ id: 5 }), makeServer());

    expect(auditLogService.record).toHaveBeenCalledWith({
      actorClass: 'task',
      actorId: 5,
      event: 'task_token.issued',
      detail: { taskId: 5, tokenId: 1, reason: 'window_regenerated' },
    });
    const detailJson = JSON.stringify(auditLogService.record.mock.calls[0][0].detail);
    expect(detailJson).not.toContain('azt.task.');
  });

  it('does not throw when auditLogService is not provided', () => {
    const taskTokenRepo: Pick<ITaskTokenRepository, 'issueNextGeneration' | 'revokeAllForTask' | 'revoke'> = {
      issueNextGeneration: vi.fn(() => ({ id: 1, token: 'azt.task.1.' + 'a'.repeat(64) })),
      revokeAllForTask: vi.fn(() => 1),
      revoke: vi.fn(() => 1),
    };
    const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []) };
    const service = new TaskPaneEnvironmentService(taskTokenRepo as ITaskTokenRepository, projectSecretRepo as any, 'ui-token-123', false);

    expect(() => service.buildEnvForNewWindow(makeTask(), makeServer())).not.toThrow();
  });
});

// Issue #28 third-party review finding (multi-window token rotation
// collision): a secondary task window must never rotate/issue the task's
// AZITO_TASK_TOKEN — that generation is bound one-to-one to the task's
// primary worker window, and issueNextGeneration revokes every other
// outstanding generation for the task as part of rotating.
describe('TaskPaneEnvironmentService.buildEnvForSecondaryWindow', () => {
  it('never calls issueNextGeneration and never sets AZITO_TASK_TOKEN or project secrets', () => {
    const { service, taskTokenRepo, projectSecretRepo } = makeDeps(false);
    const env = service.buildEnvForSecondaryWindow(makeTask({ id: 5, projectId: 7 }), makeServer());

    expect(taskTokenRepo.issueNextGeneration).not.toHaveBeenCalled();
    expect(projectSecretRepo.findByProjectWithValues).not.toHaveBeenCalled();
    expect(env.AZITO_TASK_TOKEN).toBeUndefined();
    expect('AZITO_SECRET_FOO' in env).toBe(false);
    expect(env.AZITO_TASK_ID).toBe('5');
  });

  it('injects AZITO_UI_TOKEN when the scoped-auth flag is off (compat mode)', () => {
    const { service } = makeDeps(false);
    const env = service.buildEnvForSecondaryWindow(makeTask(), makeServer());
    expect(env.AZITO_UI_TOKEN).toBe('ui-token-123');
  });

  it('explicitly overrides AZITO_UI_TOKEN/AZITO_AGENT_TOKEN to empty when the scoped-auth flag is on', () => {
    const { service } = makeDeps(true);
    const agentServer = makeServer({ type: 'agent', agentPort: 4001, agentToken: 'secret-agent-token' });
    const env = service.buildEnvForSecondaryWindow(makeTask(), agentServer);
    expect(env.AZITO_UI_TOKEN).toBe('');
    expect(env.AZITO_AGENT_TOKEN).toBe('');
  });

  // Issue #29 review, Critical finding 1 (same fix as buildEnvForNewWindow).
  it('masks AZITO_UI_TOKEN/AZITO_AGENT_TOKEN to empty for an isolated agent server even in compat mode', () => {
    const { service } = makeDeps(false);
    const isolatedAgent = makeServer({ type: 'agent', agentPort: 4001, agentToken: 'secret-agent-token', isolationIntent: true });
    const env = service.buildEnvForSecondaryWindow(makeTask(), isolatedAgent);

    expect(env.AZITO_UI_TOKEN).toBe('');
    expect(env.AZITO_AGENT_TOKEN).toBe('');
    expect(env.AZITO_AGENT_PORT).toBeUndefined();
  });
});

// Issue #28 third-party review finding: window-destroy paths (route
// kill-window, execute()/restore() rollback branches) must revoke the
// generation this class just issued when the window it belongs to is
// confirmed destroyed and won't be resumed onto.
describe('TaskPaneEnvironmentService.revokeForDestroyedWindow', () => {
  it('delegates straight to taskTokenRepo.revokeAllForTask with the given reason', () => {
    const { service, taskTokenRepo } = makeDeps(true);
    service.revokeForDestroyedWindow(5, 'worktree_creation_failed_rollback');
    expect(taskTokenRepo.revokeAllForTask).toHaveBeenCalledWith(5, 'worktree_creation_failed_rollback');
  });

  // Issue #28 third-party review Important finding: the audit UI's own
  // description claims task-token revocation as a category it shows, but
  // nothing ever recorded it.
  it('records a task_token.revoked audit event when at least one generation was actually revoked', () => {
    const { service, taskTokenRepo, auditLogService } = makeDeps(true);
    (taskTokenRepo.revokeAllForTask as ReturnType<typeof vi.fn>).mockReturnValue(2);

    service.revokeForDestroyedWindow(5, 'worktree_creation_failed_rollback');

    expect(auditLogService.record).toHaveBeenCalledWith({
      actorClass: 'task',
      actorId: 5,
      event: 'task_token.revoked',
      detail: { taskId: 5, reason: 'worktree_creation_failed_rollback', revokedCount: 2 },
    });
  });

  it('does not record an audit event for a no-op revoke (nothing was active to revoke)', () => {
    const { service, taskTokenRepo, auditLogService } = makeDeps(true);
    (taskTokenRepo.revokeAllForTask as ReturnType<typeof vi.fn>).mockReturnValue(0);

    service.revokeForDestroyedWindow(5, 'task_deleted');

    expect(auditLogService.record).not.toHaveBeenCalled();
  });
});

// Issue #28 third-party review finding: a rotation rollback (createRotatedWindow/
// rollbackWindowReference in WindowRotation.ts) must revoke only the specific
// generation it just issued, never every active generation for the task —
// otherwise it can revoke a DIFFERENT, newer generation a concurrent rotation
// for the same task already persisted.
describe('TaskPaneEnvironmentService.revokeGeneration', () => {
  it('delegates straight to taskTokenRepo.revoke with the given tokenId and reason', () => {
    const { service, taskTokenRepo } = makeDeps(true);
    service.revokeGeneration(7, 'execute_create_failed');
    expect(taskTokenRepo.revoke).toHaveBeenCalledWith(7, 'execute_create_failed');
  });

  // Issue #28 third-party review Important finding: the audit UI's own
  // description claims task-token revocation as a category it shows, but
  // nothing ever recorded it.
  it('records a task_token.revoked audit event (generation id + reason, no taskId available at this scope)', () => {
    const { service, auditLogService } = makeDeps(true);
    service.revokeGeneration(7, 'execute_create_failed');

    expect(auditLogService.record).toHaveBeenCalledWith({
      actorClass: 'task',
      actorId: null,
      event: 'task_token.revoked',
      detail: { tokenId: 7, reason: 'execute_create_failed' },
    });
  });

  it('does not record an audit event when the generation was already revoked (no-op)', () => {
    const { service, taskTokenRepo, auditLogService } = makeDeps(true);
    (taskTokenRepo.revoke as ReturnType<typeof vi.fn>).mockReturnValue(0);

    service.revokeGeneration(7, 'execute_create_failed');

    expect(auditLogService.record).not.toHaveBeenCalled();
  });
});
