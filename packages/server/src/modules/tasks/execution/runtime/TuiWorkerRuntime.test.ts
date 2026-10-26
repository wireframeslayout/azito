import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { TuiNotReadyError, TuiWorkerRuntime, workerNotReadyReason } from './TuiWorkerRuntime';
import { WorkerNotRunningError } from '../WorkerInputService';
import { posixDialect } from '../../../../shared/os/shellDialect';

function makeRuntime(capturePaneResponses: string[], foreground: string | null = 'claude') {
  let callIndex = 0;
  const tmux = {
    sendKeysToHandle: vi.fn(async () => {}),
    paneCommandByHandle: vi.fn(async () => foreground),
    captureScreen: vi.fn(async () => {
      const stdout = capturePaneResponses[callIndex] ?? capturePaneResponses[capturePaneResponses.length - 1];
      callIndex++;
      return { stdout };
    }),
  };
  const workerInput = { sendPrompt: vi.fn(async () => {}) };
  const promptFiles = { stage: vi.fn(async () => 'AZITO prompt file. Read the file named at the end of this line and carry out every instruction in it exactly: /tmp/azito-prompt-1-ab.md') };
  const workerWaiter = { startSignalStream: vi.fn() };
  const httpSignalCoordinator = { start: vi.fn() };
  const supervisorRegistry = { issueLaunch: vi.fn(() => undefined) };
  const runtime = new TuiWorkerRuntime(workerInput as any, workerWaiter as any, httpSignalCoordinator as any, supervisorRegistry as any, '', promptFiles as any);
  return { runtime, tmux, workerInput, promptFiles };
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

  it('waits for the composer of a codex worker (rust-v0.149 / v0.164 placeholder and footer)', async () => {
    const { runtime, tmux } = makeRuntime(['', '› Ask Codex to do anything\n  ? for shortcuts                100% context left'], 'codex');
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
    expect(tmux.captureScreen.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('stops on the codex update prompt with the reason (its default answer would run the update)', async () => {
    const { runtime, tmux } = makeRuntime([[
      '✨ Update available! 0.149.1 -> 0.164.0',
      '1. Update now (runs `sh -c \'curl -fsSL https://chatgpt.com/codex/install.sh | sh\'`)',
      '2. Skip',
      '3. Skip until next version',
      'Press enter to continue',
    ].join('\n')], 'codex');
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'codex --dangerously-bypass-approvals-and-sandbox' };
    await expect(runtime.launch(ctx)).rejects.toMatchObject({ name: 'TuiNotReadyError', reason: 'codex_update_prompt' });
  }, 15_000);

  it.each([
    ['rust-v0.149', 'Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.\n› 1. Yes, continue\n  2. No, quit'],
    ['rust-v0.164', '  Folder access\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n› 1. Trust and continue\n  2. Quit'],
  ])('stops on the codex folder trust screen (%s)', async (_version, screen) => {
    const { runtime, tmux } = makeRuntime([screen], 'codex');
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'codex --dangerously-bypass-approvals-and-sandbox' };
    await expect(runtime.launch(ctx)).rejects.toMatchObject({ name: 'TuiNotReadyError', reason: 'codex_trust_prompt' });
  }, 15_000);

  it('stops with worker_exited_to_shell when the agent ended and the pane is back at a shell', async () => {
    const { runtime, tmux } = makeRuntime(['user@host:~/wt$ '], 'bash');
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'codex --dangerously-bypass-approvals-and-sandbox' };
    await expect(runtime.launch(ctx)).rejects.toMatchObject({ name: 'TuiNotReadyError', reason: 'worker_exited_to_shell' });
  }, 15_000);

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
    await expect(runtime.launch(ctx)).rejects.toMatchObject({ name: 'TuiNotReadyError', reason: 'trust_dialog' });
    expect(tmux.sendKeysToHandle).not.toHaveBeenCalled();
  }, 15_000);
});

describe('TuiWorkerRuntime.launch — the Bypass Permissions mode dialog (Claude Code 2.1.310 / 2.0.50 texts)', () => {
  const dialog = [
    '╭──────────────────────────────────────────────╮',
    '│ WARNING: Claude Code running in Bypass Permissions mode',
    '│ In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
    '│ By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
    '│ ❯ 1. No, exit',
    '│   2. Yes, I accept',
  ].join('\n');

  it('is not taken for a ready TUI: fails with the reason, and types nothing into the dialog', async () => {
    const { runtime, tmux } = makeRuntime([dialog]);
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'claude --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).rejects.toMatchObject({ name: 'TuiNotReadyError', reason: 'bypass_permissions_dialog' });
    expect(tmux.sendKeysToHandle).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('is recognised when the pane wraps the title across lines', async () => {
    const { runtime, tmux } = makeRuntime(['│ WARNING: Claude Code running in      │\n│ Bypass Permissions mode              │\n│ ❯ 1. No,   │\n│ exit  2. Yes, I accept │\n']);
    const ctx = { ...makeLaunchCtx(tmux), startedAsProgram: true, effectiveLaunchCommand: 'claude --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).rejects.toMatchObject({ reason: 'bypass_permissions_dialog' });
  }, 15_000);

  it('is not mistaken for the dialog when a conversation quotes its sentences next to the ready status line', async () => {
    const { runtime, tmux } = makeRuntime([[
      'Claude',
      'Earlier answer: By proceeding, you accept all responsibility for this deployment.',
      'The dialog is titled "WARNING: Claude Code running in Bypass Permissions mode" and offers "No, exit".',
      'bypass permissions on (shift+tab to cycle)',
    ].join('\n')]);
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'claude --resume 7a8b0f9c-1d2e-4f30-8a45-6b7c8d9e0f12 --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
  }, 15_000);

  it('still treats the status line of a running TUI as ready', async () => {
    const { runtime, tmux } = makeRuntime(['bypass permissions on (shift+tab to cycle)']);
    const ctx = { ...makeLaunchCtx(tmux), effectiveLaunchCommand: 'claude --dangerously-skip-permissions' };
    await expect(runtime.launch(ctx)).resolves.toBeDefined();
  }, 15_000);
});

describe('TuiWorkerRuntime.sendPrompt — nothing of the prompt is typed into a worker that cannot take it (#532)', () => {
  const ctxFor = (tmux: any, agentKind: 'claude' | 'codex' | null) => ({ server, handle: asPaneHandle('sess:1.1'), driver: tmux, supervisorTarget: 'sess:1', taskId: 1, unitId: 1, agentKind });
  const PROMPT = 'do the task\n$(rm -rf ~)\n`id`; echo pwned';

  it('types only the one-line instruction, never the prompt, and writes the prompt to the file', async () => {
    const { runtime, tmux, workerInput, promptFiles } = makeRuntime(['› Ask Codex to do anything\n? for shortcuts'], 'codex');
    await runtime.sendPrompt(ctxFor(tmux, 'codex'), PROMPT);
    expect(promptFiles.stage).toHaveBeenCalledWith(server, 1, 1, PROMPT);
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(1);
    const typed = (workerInput.sendPrompt.mock.calls[0] as unknown as unknown[])[2] as string;
    expect(typed).not.toContain('rm -rf');
    expect(typed).not.toContain('\n');
  });

  it.each([
    ['codex', 'codex_update_prompt', 'Update available! 0.149.1 -> 0.164.0\n1. Update now\n3. Skip until next version'],
    ['codex', 'codex_trust_prompt', 'Do you trust the contents of this directory?\n1. Yes, continue\n2. No, quit'],
    ['claude', 'trust_dialog', 'Do you trust this folder?'],
    ['claude', 'bypass_permissions_dialog', 'WARNING: Claude Code running in Bypass Permissions mode\n1. No, exit\n2. Yes, I accept'],
  ] as const)('a %s worker showing %s: fails with the reason and sends nothing', async (kind, reason, screen) => {
    const { runtime, tmux, workerInput, promptFiles } = makeRuntime([screen], kind);
    await expect(runtime.sendPrompt(ctxFor(tmux, kind), PROMPT)).rejects.toMatchObject({ name: 'TuiNotReadyError', reason });
    expect(workerInput.sendPrompt).not.toHaveBeenCalled();
    expect(tmux.sendKeysToHandle).not.toHaveBeenCalled();
    expect(promptFiles.stage).not.toHaveBeenCalled();
  });

  it('does not read the screen of a generic worker', async () => {
    const { runtime, tmux, workerInput } = makeRuntime([''], 'some-tool');
    await runtime.sendPrompt(ctxFor(tmux, null), PROMPT);
    expect(tmux.captureScreen).not.toHaveBeenCalled();
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('TuiWorkerRuntime.sendPrompt — the worker has to be at its input (positive check, #532)', () => {
  const ctxFor = (tmux: any, agentKind: 'claude' | 'codex') => ({ server, handle: asPaneHandle('sess:1.1'), driver: tmux, supervisorTarget: 'sess:1', taskId: 1, unitId: 1, agentKind });
  const READY = { codex: '› Ask Codex to do anything\n  ? for shortcuts   100% context left', claude: 'bypass permissions on (shift+tab to cycle)' } as const;

  /** Runs sendPrompt on fake timers so the few seconds a screen is given to finish drawing cost nothing. */
  async function sendWithFakeTimers(run: () => Promise<void>): Promise<unknown> {
    vi.useFakeTimers();
    try {
      const settled = run().then(() => null, (err: unknown) => err);
      await vi.advanceTimersByTimeAsync(10_000);
      return await settled;
    } finally {
      vi.useRealTimers();
    }
  }

  it.each([
    ['codex', 'an unknown screen', 'Welcome to Codex\n› 1. Sign in with ChatGPT\n  2. Provide your own API key'],
    ['codex', 'an empty screen', ''],
    ['claude', 'an unknown screen', 'Choose the text style that looks best with your terminal\n❯ 1. Dark mode\n  2. Light mode'],
    ['claude', 'an empty screen', '\n\n'],
  ] as const)('a %s worker showing %s: refused after the grace, nothing sent and no prompt file written', async (kind, _name, screen) => {
    const { runtime, tmux, workerInput, promptFiles } = makeRuntime([screen], kind);
    const err = await sendWithFakeTimers(() => runtime.sendPrompt(ctxFor(tmux, kind), 'the prompt'));
    expect(err).toMatchObject({ name: 'TuiNotReadyError', reason: 'not_ready' });
    expect(workerInput.sendPrompt).not.toHaveBeenCalled();
    expect(tmux.sendKeysToHandle).not.toHaveBeenCalled();
    expect(promptFiles.stage).not.toHaveBeenCalled();
    expect(tmux.captureScreen.mock.calls.length).toBeGreaterThan(2);
  });

  it('a pane that is back at a shell is refused at once, before the prompt file is written', async () => {
    const { runtime, tmux, workerInput, promptFiles } = makeRuntime(['user@host:~/wt$ '], 'bash');
    const err = await sendWithFakeTimers(() => runtime.sendPrompt(ctxFor(tmux, 'codex'), 'the prompt'));
    expect(err).toMatchObject({ name: 'TuiNotReadyError', reason: 'worker_exited_to_shell' });
    expect(promptFiles.stage).not.toHaveBeenCalled();
    expect(workerInput.sendPrompt).not.toHaveBeenCalled();
  });

  it('a screen that is still drawing gets the grace: the line is sent once the input shows', async () => {
    const { runtime, tmux, workerInput, promptFiles } = makeRuntime(['', '', READY.codex], 'codex');
    const err = await sendWithFakeTimers(() => runtime.sendPrompt(ctxFor(tmux, 'codex'), 'the prompt'));
    expect(err).toBeNull();
    expect(promptFiles.stage).toHaveBeenCalledTimes(1);
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('a screen that turns into a dialog while the prompt file is being written is refused: the file exists, the line is not sent', async () => {
    const update = 'Update available! 0.149.1 -> 0.164.0\n1. Update now\n2. Skip\n3. Skip until next version';
    // first check: input; second check, after the file was written: the update prompt.
    const { runtime, tmux, workerInput, promptFiles } = makeRuntime([READY.codex, update], 'codex');
    const err = await sendWithFakeTimers(() => runtime.sendPrompt(ctxFor(tmux, 'codex'), 'the prompt'));
    expect(err).toMatchObject({ name: 'TuiNotReadyError', reason: 'codex_update_prompt' });
    expect(promptFiles.stage).toHaveBeenCalledTimes(1);
    expect(workerInput.sendPrompt).not.toHaveBeenCalled();
    expect(tmux.sendKeysToHandle).not.toHaveBeenCalled();
  });

  it('a screen that turns into an unknown one while the prompt file is being written is refused as not_ready', async () => {
    const { runtime, tmux, workerInput } = makeRuntime([READY.claude, 'something else entirely'], 'claude');
    const err = await sendWithFakeTimers(() => runtime.sendPrompt(ctxFor(tmux, 'claude'), 'the prompt'));
    expect(err).toMatchObject({ name: 'TuiNotReadyError', reason: 'not_ready' });
    expect(workerInput.sendPrompt).not.toHaveBeenCalled();
  });

  it('writes the file only between two confirmations of the input', async () => {
    const { runtime, tmux, promptFiles } = makeRuntime([READY.codex], 'codex');
    const order: string[] = [];
    tmux.captureScreen.mockImplementation(async () => { order.push('screen'); return { stdout: READY.codex }; });
    promptFiles.stage.mockImplementation(async () => { order.push('stage'); return 'AZITO prompt file. x: /tmp/azito-prompt-1-ab.md'; });
    await runtime.sendPrompt(ctxFor(tmux, 'codex'), 'the prompt');
    expect(order).toEqual(['screen', 'stage', 'screen']);
  });
});

describe('workerNotReadyReason', () => {
  it('names a dialog, a worker back at a shell, and nothing else', () => {
    expect(workerNotReadyReason(new TuiNotReadyError('codex_update_prompt', ''))).toBe('worker_not_ready: codex_update_prompt');
    expect(workerNotReadyReason(new WorkerNotRunningError('bash'))).toBe('worker_not_ready: worker_exited_to_shell');
    expect(workerNotReadyReason(new Error('boom'))).toBeNull();
  });
});
