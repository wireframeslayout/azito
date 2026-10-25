import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { TuiWorkerRuntime } from './TuiWorkerRuntime';
import { posixDialect } from '../../../../shared/os/shellDialect';

function makeRuntime(capturePaneResponses: string[]) {
  let callIndex = 0;
  const tmux = {
    sendKeysToHandle: vi.fn(async () => {}),
    captureScreen: vi.fn(async () => {
      const stdout = capturePaneResponses[callIndex] ?? capturePaneResponses[capturePaneResponses.length - 1];
      callIndex++;
      return { stdout };
    }),
  };
  const workerInput = { sendPrompt: vi.fn(async () => {}) };
  const workerWaiter = { startSignalStream: vi.fn() };
  const httpSignalCoordinator = { start: vi.fn() };
  const supervisorRegistry = { issueLaunch: vi.fn(() => undefined) };
  const runtime = new TuiWorkerRuntime(workerInput as any, workerWaiter as any, httpSignalCoordinator as any, supervisorRegistry as any);
  return { runtime, tmux };
}

const server = { name: 'local', type: 'local' } as any;

function makeLaunchCtx(tmux: any) {
  return {
    server,
    handle: asPaneHandle('sess:1.1'),
    driver: tmux,
    supervisorTarget: 'sess:1',
    taskId: 1,
    unitId: 1,
    windowKind: 'tmux' as const,
    windowType: 'agent',
    workerExecutionMode: 'tmux-pipe' as const,
    dialect: posixDialect,
    startedAsProgram: false,
  };
}

describe('TuiWorkerRuntime.launch — waitForTuiReady', () => {
  it('returns immediately after polling when TUI shows ready indicators (claude worker)', async () => {
    const { runtime, tmux } = makeRuntime(['bypass permissions on (shift+tab to cycle)']);
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'claude --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
  }, 15_000);

  it('polls until TUI is ready (claude worker)', async () => {
    const { runtime, tmux } = makeRuntime(['', '', 'shift+tab to cycle']);
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'claude --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.captureScreen.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('does NOT poll or throw for codex worker — returns after fixed 3s sleep', async () => {
    const { runtime, tmux } = makeRuntime([]);
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'codex --dangerously-bypass-approvals-and-sandbox' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.captureScreen).not.toHaveBeenCalled();
  }, 10_000);

  it('does NOT poll or throw for generic worker', async () => {
    const { runtime, tmux } = makeRuntime([]);
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: '/usr/bin/some-generic-tool' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.captureScreen).not.toHaveBeenCalled();
  }, 10_000);
});

describe('TuiWorkerRuntime.launch — a worker started as the pane\'s program (Windows)', () => {
  it('types nothing into the pane, only waits for the TUI, and names the launch it was started with', async () => {
    const { runtime, tmux } = makeRuntime(['bypass permissions on (shift+tab to cycle)']);
    const ctx = { ...makeLaunchCtx(tmux), startedAsProgram: true, effectiveLaunchCommand: 'claude --session-id 7a8b0f9c-1d2e-4f30-8a45-6b7c8d9e0f12' };
    await expect(runtime.launch(ctx)).resolves.toBe(ctx.effectiveLaunchCommand);
    expect(tmux.sendKeysToHandle).not.toHaveBeenCalled();
    expect(tmux.captureScreen).toHaveBeenCalled();
  }, 15_000);

  it('still stops on the trust dialog of a Claude worker', async () => {
    const { runtime, tmux } = makeRuntime(['Do you trust this folder?']);
    const ctx = { ...makeLaunchCtx(tmux), startedAsProgram: true, effectiveLaunchCommand: 'claude' };
    await expect(runtime.launch(ctx)).rejects.toMatchObject({ name: 'TuiNotReadyError', trustDialogDetected: true });
    expect(tmux.sendKeysToHandle).not.toHaveBeenCalled();
  }, 15_000);
});
