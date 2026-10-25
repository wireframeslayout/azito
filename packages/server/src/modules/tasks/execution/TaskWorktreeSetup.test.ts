import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskWorktree, type TaskWorktreeDeps, type TaskWorktreeRequest } from './TaskWorktreeSetup';
import { ensureClaudeBypassAccepted } from '../../agents/claude/ensureClaudeBypassAccepted';

vi.mock('../../agents/claude/ensureClaudeTrust', () => ({ ensureClaudeTrust: vi.fn(async () => ({ action: 'already_trusted' })) }));
vi.mock('../../agents/claude/ensureClaudeBypassAccepted', () => ({ ensureClaudeBypassAccepted: vi.fn() }));
vi.mock('../../git/ensureGitIdentity', () => ({ ensureGitIdentity: vi.fn(async () => ({ action: 'unchanged' })) }));

const transport = { files: () => ({ platform: 'linux', realpath: async (p: string) => p }) };

function makeDeps() {
  const appendLog = vi.fn();
  const deps = {
    taskRepo: { update: vi.fn() },
    contentExtractor: { generateSlug: vi.fn(async () => 'slug') },
    transportFactory: { getTransport: () => transport, getFileOps: () => transport.files() },
    worktreeServiceFactory: { create: () => ({ create: async () => ({ path: '/wt', branch: 'b' }) }) },
    hubGitIdentity: null,
    appendLog,
  } as unknown as TaskWorktreeDeps;
  return { deps, appendLog };
}

const request = (workerType: string | null): TaskWorktreeRequest => ({
  server: { name: 's', type: 'local' } as TaskWorktreeRequest['server'],
  task: { id: 1, title: 't', branch: null },
  unitId: 2,
  workerType,
  workingDir: '/repo',
  allowedRoot: null,
  baseBranch: 'main',
  distStatus: null,
  slug: null,
});

describe('createTaskWorktree — Claude Bypass Permissions dialog', () => {
  beforeEach(() => {
    vi.mocked(ensureClaudeBypassAccepted).mockReset();
  });

  it('accepts the dialog for a Claude worker and logs it', async () => {
    vi.mocked(ensureClaudeBypassAccepted).mockResolvedValue({ action: 'accepted' });
    const { deps, appendLog } = makeDeps();
    await createTaskWorktree(deps, request('claude'), async () => {});
    expect(ensureClaudeBypassAccepted).toHaveBeenCalledTimes(1);
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'claude_bypass_accepted' });
  });

  it('logs why it was skipped and goes on', async () => {
    vi.mocked(ensureClaudeBypassAccepted).mockResolvedValue({ action: 'skipped', reason: 'not valid JSON' });
    const { deps, appendLog } = makeDeps();
    await expect(createTaskWorktree(deps, request('claude'), async () => {})).resolves.toMatchObject({ path: '/wt' });
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'claude_bypass_skipped', reason: 'not valid JSON' });
  });

  it('logs a failure and goes on', async () => {
    vi.mocked(ensureClaudeBypassAccepted).mockRejectedValue(new Error('disk full'));
    const { deps, appendLog } = makeDeps();
    await expect(createTaskWorktree(deps, request('claude'), async () => {})).resolves.toMatchObject({ path: '/wt' });
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'claude_bypass_failed', reason: 'disk full' });
  });

  it.each(['codex', 'generic', null])('does not touch Claude settings for a %s worker', async (workerType) => {
    const { deps } = makeDeps();
    await createTaskWorktree(deps, request(workerType), async () => {});
    expect(ensureClaudeBypassAccepted).not.toHaveBeenCalled();
  });
});
