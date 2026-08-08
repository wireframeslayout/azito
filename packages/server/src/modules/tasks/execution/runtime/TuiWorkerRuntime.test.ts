import { describe, it, expect, vi } from 'vitest';
import { TuiWorkerRuntime } from './TuiWorkerRuntime';

function makeRuntime(capturePaneResponses: string[]) {
  let callIndex = 0;
  const tmux = {
    sendKeys: vi.fn(async () => {}),
    capturePane: vi.fn(async () => {
      const stdout = capturePaneResponses[callIndex] ?? capturePaneResponses[capturePaneResponses.length - 1];
      callIndex++;
      return { stdout };
    }),
  };
  const workerInput = { sendPrompt: vi.fn(async () => {}) };
  const workerWaiter = { startSignalStream: vi.fn() };
  const httpSignalCoordinator = { start: vi.fn() };
  const supervisorRegistry = { issueLaunch: vi.fn(() => undefined) };
  const runtime = new TuiWorkerRuntime(tmux as any, workerInput as any, workerWaiter as any, httpSignalCoordinator as any, supervisorRegistry as any);
  return { runtime, tmux };
}

const server = { name: 'local', type: 'local' } as any;
const baseLaunchCtx = {
  server,
  target: 'sess:1.1',
  supervisorTarget: 'sess:1',
  taskId: 1,
  unitId: 1,
  windowType: 'agent',
  workerExecutionMode: 'tmux-pipe' as const,
};

describe('TuiWorkerRuntime.launch — waitForTuiReady', () => {
  it('returns immediately after polling when TUI shows ready indicators (claude worker)', async () => {
    const { runtime } = makeRuntime(['bypass permissions on (shift+tab to cycle)']);
    const ctx = { ...baseLaunchCtx, effectiveLaunchCommand: 'claude --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
  }, 15_000);

  it('polls until TUI is ready (claude worker)', async () => {
    const { runtime, tmux } = makeRuntime(['', '', 'shift+tab to cycle']);
    const ctx = { ...baseLaunchCtx, effectiveLaunchCommand: 'claude --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.capturePane.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('does NOT poll or throw for codex worker — returns after fixed 3s sleep', async () => {
    const { runtime, tmux } = makeRuntime([]);
    const ctx = { ...baseLaunchCtx, effectiveLaunchCommand: 'codex --dangerously-bypass-approvals-and-sandbox' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.capturePane).not.toHaveBeenCalled();
  }, 10_000);

  it('does NOT poll or throw for generic worker', async () => {
    const { runtime, tmux } = makeRuntime([]);
    const ctx = { ...baseLaunchCtx, effectiveLaunchCommand: '/usr/bin/some-generic-tool' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.capturePane).not.toHaveBeenCalled();
  }, 10_000);
});
