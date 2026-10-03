import { describe, it, expect, vi } from 'vitest';
import { TaskCleanupService } from './TaskCleanupService';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../tmux/MuxCapabilityError';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { Task } from './Task';

const WINDOW_ID = 'w_01M3XFD8H97JCPKS5Y5BH3JZQH';
const ok = { stdout: '', stderr: '', code: 0 };

function setup(opts: { windows?: unknown[]; closeWindow?: ReturnType<typeof vi.fn>; resolveThrows?: boolean }) {
  const closeWindow = opts.closeWindow ?? vi.fn(async () => ok);
  const driver = { kind: 'misao', closeWindow } as unknown as IMuxClient;
  const registry = new MuxDriverRegistry({ misaoEnabled: true });
  registry.register('misao', driver, opts.resolveThrows ? () => ({ available: false, reason: 'daemon_unreachable' }) : undefined);
  const server = { name: 'local', type: 'local', muxRuntime: 'misao' };
  const service = new TaskCleanupService({
    serverRepo: { findByName: () => server } as never,
    worktreeServiceFactory: {} as never,
    transportFactory: {} as never,
    projectServerRepo: { find: () => ({ tmuxSession: 'azito' }), findByProject: () => [] } as never,
    projectRepo: {} as never,
    muxDriverRegistry: registry,
    windowRepo: { findByTask: () => opts.windows ?? [] } as never,
  });
  const log = { warn: vi.fn() };
  const task = { id: 987654, projectId: 1, serverName: 'local', tmuxWindow: WINDOW_ID, worktreePath: null } as unknown as Task;
  return { service, closeWindow, log, task };
}

describe('TaskCleanupService window close', () => {
  it('closes the window by the primary row\'s mux_ref, even when task.tmuxWindow holds something else (a restored task)', async () => {
    const ref = { kind: 'misao', workspace: 'azito', window: WINDOW_ID };
    const { service, closeWindow, log, task } = setup({ windows: [{ isPrimary: true, ownerType: 'task', tmuxTarget: `azito:${WINDOW_ID}`, muxRef: ref }] });
    task.tmuxWindow = 'task-1--ab12';

    await service.cleanup(task, log);

    expect(closeWindow).toHaveBeenCalledWith(expect.anything(), ref);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('closes by task.tmuxWindow (a window id) when there is no row', async () => {
    const { service, closeWindow, log, task } = setup({});

    await service.cleanup(task, log);

    expect(closeWindow).toHaveBeenCalledWith(expect.anything(), { kind: 'misao', workspace: 'azito', window: WINDOW_ID });
  });

  it('warns when the close result is a failure (an RPC error is a non-zero result, not a rejection)', async () => {
    const { service, log, task } = setup({ closeWindow: vi.fn(async () => ({ stdout: '', stderr: 'pane busy', code: 1 })) });

    await service.cleanup(task, log);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pane busy'));
  });

  it('does not warn when the window was already gone', async () => {
    const { service, log, task } = setup({ closeWindow: vi.fn(async () => ({ stdout: '', stderr: 'not found', code: 1, alreadyGone: true })) });

    await service.cleanup(task, log);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips the close with a warning while the daemon is down and still finishes cleanup', async () => {
    const { service, closeWindow, log, task } = setup({ resolveThrows: true });

    await expect(service.cleanup(task, log)).resolves.toBeUndefined();

    expect(closeWindow).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(new MuxDriverUnavailableError('misao', 'daemon_unreachable').message));
  });
});
