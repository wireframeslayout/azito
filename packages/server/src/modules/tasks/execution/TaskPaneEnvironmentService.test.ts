import { describe, it, expect, vi } from 'vitest';
import { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';
import type { ITaskTokenRepository } from '../tokens/TaskToken';
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
    muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDeps(scopedAuthEnabled: boolean) {
  const taskTokenRepo: Pick<ITaskTokenRepository, 'issueNextGeneration' | 'revokeAllForTask'> = {
    issueNextGeneration: vi.fn(() => ({ id: 1, token: 'azt.task.1.' + 'a'.repeat(64) })),
    revokeAllForTask: vi.fn(() => 1),
  };
  const projectSecretRepo = {
    findByProjectWithValues: vi.fn(() => [{ id: 1, projectId: 7, name: 'FOO', value: 'bar', createdAt: '', updatedAt: '' }]),
  };
  const service = new TaskPaneEnvironmentService(taskTokenRepo as ITaskTokenRepository, projectSecretRepo as any, 'ui-token-123', scopedAuthEnabled);
  return { service, taskTokenRepo, projectSecretRepo };
}

describe('TaskPaneEnvironmentService.buildEnvForNewWindow', () => {
  it('always sets AZITO_TASK_TOKEN/AZITO_TASK_ID and project secrets, rotating via issueNextGeneration', () => {
    const { service, taskTokenRepo } = makeDeps(false);
    const env = service.buildEnvForNewWindow(makeTask({ id: 5, projectId: 7 }), makeServer());

    expect(taskTokenRepo.issueNextGeneration).toHaveBeenCalledWith(5, 'window_regenerated');
    expect(env.AZITO_TASK_TOKEN).toMatch(/^azt\.task\.1\./);
    expect(env.AZITO_TASK_ID).toBe('5');
    expect(env.AZITO_SECRET_FOO).toBe('bar');
  });

  it('injects AZITO_UI_TOKEN when the scoped-auth flag is off (compat mode)', () => {
    const { service } = makeDeps(false);
    const env = service.buildEnvForNewWindow(makeTask(), makeServer());
    expect(env.AZITO_UI_TOKEN).toBe('ui-token-123');
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
    const env = service.buildEnvForNewWindow(makeTask(), makeServer());
    expect(env.AZITO_UI_TOKEN).toBe('');
  });

  it('injects AZITO_AGENT_TOKEN/AZITO_AGENT_PORT for an agent server only when the flag is off, and explicitly blanks AZITO_AGENT_TOKEN when on', () => {
    const agentServer = makeServer({ type: 'agent', agentPort: 4001, agentToken: 'secret-agent-token' });

    const off = makeDeps(false);
    const envOff = off.service.buildEnvForNewWindow(makeTask(), agentServer);
    expect(envOff.AZITO_AGENT_TOKEN).toBe('secret-agent-token');
    expect(envOff.AZITO_AGENT_PORT).toBe('4001');

    const on = makeDeps(true);
    const envOn = on.service.buildEnvForNewWindow(makeTask(), agentServer);
    expect(envOn.AZITO_AGENT_TOKEN).toBe('');
    expect(envOn.AZITO_AGENT_PORT).toBeUndefined();
  });

  it('never injects AZITO_AGENT_TOKEN for a local server even in compat mode', () => {
    const { service } = makeDeps(false);
    const env = service.buildEnvForNewWindow(makeTask(), makeServer({ type: 'local' }));
    expect(env.AZITO_AGENT_TOKEN).toBeUndefined();
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
});
