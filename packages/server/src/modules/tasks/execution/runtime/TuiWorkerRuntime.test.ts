import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { TuiWorkerRuntime } from './TuiWorkerRuntime';
import { posixDialect } from '../../../../shared/os/shellDialect';
import { commandLineLaunch, flag, type ProgramLaunch } from '../../../agents/WorkerLaunch';

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
    startsAsProgram: false,
    cwd: null,
    paneEnv: null,
    files: () => { throw new Error('not expected'); },
  };
}

describe('TuiWorkerRuntime.launch — waitForTuiReady', () => {
  it('returns immediately after polling when TUI shows ready indicators (claude worker)', async () => {
    const { runtime, tmux } = makeRuntime(['bypass permissions on (shift+tab to cycle)']);
    const ctx = { ...makeLaunchCtx(tmux), launch: commandLineLaunch('claude --dangerously-skip-permissions') };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
  }, 15_000);

  it('polls until TUI is ready (claude worker)', async () => {
    const { runtime, tmux } = makeRuntime(['', '', 'shift+tab to cycle']);
    const ctx = { ...makeLaunchCtx(tmux), launch: commandLineLaunch('claude --dangerously-skip-permissions') };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.captureScreen.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('does NOT poll or throw for codex worker — returns after fixed 3s sleep', async () => {
    const { runtime, tmux } = makeRuntime([]);
    const ctx = { ...makeLaunchCtx(tmux), launch: commandLineLaunch('codex --dangerously-bypass-approvals-and-sandbox') };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.captureScreen).not.toHaveBeenCalled();
  }, 10_000);

  it('does NOT poll or throw for generic worker', async () => {
    const { runtime, tmux } = makeRuntime([]);
    const ctx = { ...makeLaunchCtx(tmux), launch: commandLineLaunch('/usr/bin/some-generic-tool') };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.captureScreen).not.toHaveBeenCalled();
  }, 10_000);
});

describe('TuiWorkerRuntime.launch — a host that starts the worker as a program (Windows)', () => {
  const claude: ProgramLaunch = { kind: 'program', file: 'claude', args: [flag('--dangerously-skip-permissions'), flag('--session-id'), flag('s-1')] };
  const newHandle = asPaneHandle('p_new');

  function programCtx(tmux: any, overrides: Record<string, unknown> = {}) {
    return { ...makeLaunchCtx(tmux), windowKind: 'misao' as const, startsAsProgram: true, launch: claude, cwd: 'C:\\work\\wt', paneEnv: { AZITO_TASK_TOKEN: 't' }, ...overrides };
  }

  it('hands the program, its directory, the UI terminal size and the window env to the mux, and runs in the pane that replaced the shell', async () => {
    const { runtime, tmux } = makeRuntime(['bypass permissions on (shift+tab to cycle)']);
    const replacePaneWithProgram = vi.fn(async (..._args: unknown[]) => newHandle);
    const driver = { ...tmux, replacePaneWithProgram };

    const result = await runtime.launch(programCtx(driver));

    expect(replacePaneWithProgram).toHaveBeenCalledWith(server, asPaneHandle('sess:1.1'), {
      argv: ['claude', '--dangerously-skip-permissions', '--session-id', 's-1'],
      cwd: 'C:\\work\\wt',
      cols: 120,
      rows: 40,
      extraEnv: { AZITO_TASK_TOKEN: 't' },
    });
    expect(tmux.sendKeysToHandle).not.toHaveBeenCalled();
    expect(result.handle).toBe(newHandle);
    expect(result.command).toBe('["claude","--dangerously-skip-permissions","--session-id","s-1"]');
    expect(tmux.captureScreen).toHaveBeenCalledWith(server, newHandle, -50);
  }, 15_000);

  it('omits the directory when there is none, and refuses a pane whose env is not known instead of starting a worker without it', async () => {
    const { runtime, tmux } = makeRuntime(['bypass permissions on (shift+tab to cycle)']);
    const replacePaneWithProgram = vi.fn(async (..._args: unknown[]) => newHandle);
    const driver = { ...tmux, replacePaneWithProgram };

    await runtime.launch(programCtx(driver, { cwd: null }));
    expect((replacePaneWithProgram.mock.calls[0] as unknown[])[2]).not.toHaveProperty('cwd');

    await expect(runtime.launch(programCtx(driver, { paneEnv: null }))).rejects.toThrow(/env the pane was created with is not known/);
    expect(replacePaneWithProgram).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('does not wrap a program in a supervisor', async () => {
    const { runtime, tmux } = makeRuntime([]);
    const driver = { ...tmux, replacePaneWithProgram: vi.fn() };
    await expect(runtime.launch(programCtx(driver, { server: { name: 'agent1', type: 'agent' }, windowKind: 'tmux' }))).rejects.toThrow(/cannot run under a supervisor/);
    expect(driver.replacePaneWithProgram).not.toHaveBeenCalled();
  });
});
