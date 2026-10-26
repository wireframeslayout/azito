import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeWorkerPane, workerScreenWith } from './fakeWorkerScreen';
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

/** A screen taken from a real pane (see fixtures/). */
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const LINE = 'AZITO prompt file. Read the file named at the end of this line and carry out every instruction in it exactly: C:/Users/SERVER~1/AppData/Local/Temp/azito-prompt-99-0123456789abcdef.md';

interface HarnessOptions {
  /** The screen before anything is typed / after the line is typed / after Enter. Default: a pane whose input the keys fill and empty. */
  idle?: string;
  typed?: string;
  submitted?: string;
  foreground?: string;
  /** The text is drawn this long after it was typed (a pane that relays it slowly). */
  drawDelayMs?: number;
  /** The first N Enters are not a submit (codex read them as part of a paste). */
  enterIgnored?: number;
  supervised?: boolean;
}

/** The real runtime over a pane that reacts to the keys the way a TUI does, under fake timers. */
function sendHarness(kind: 'claude' | 'codex', options: HarnessOptions = {}) {
  const pane = createFakeWorkerPane();
  const events: Array<{ what: string; at: number }> = [];
  const state = { typedAt: -1, submits: 0, enterIgnored: options.enterIgnored ?? 0 };
  const note = (what: string) => events.push({ what, at: Date.now() });
  const screen = (): string => {
    if (state.typedAt >= 0 && state.submits === 0 && options.typed !== undefined && Date.now() - state.typedAt >= (options.drawDelayMs ?? 0)) return options.typed;
    if (state.submits > 0 && options.submitted !== undefined) return options.submitted;
    if (state.typedAt >= 0 && Date.now() - state.typedAt < (options.drawDelayMs ?? 0)) return workerScreenWith('');
    if (state.typedAt < 0 && options.idle !== undefined) return options.idle;
    return pane.screen();
  };
  const tmux = {
    sendKeysToHandle: vi.fn(async () => {}),
    paneCommandByHandle: vi.fn(async () => options.foreground ?? 'fakeagent'),
    captureScreen: vi.fn(async () => ({ stdout: screen() })),
  };
  const workerInput = {
    sendPrompt: vi.fn(async (_s: unknown, _h: unknown, text: string) => { pane.sendKeys([text, 'Enter']); }),
    isSupervised: vi.fn(() => options.supervised ?? false),
    typePrompt: vi.fn(async (_s: unknown, _h: unknown, text: string) => { state.typedAt = Date.now(); note('type'); pane.sendKeys([text]); }),
    submitPrompt: vi.fn(async () => {
      note('enter');
      state.submits++;
      if (state.enterIgnored > 0) { state.enterIgnored--; state.submits--; state.submits = Math.max(state.submits, 0); return; }
      pane.sendKeys(['Enter']);
    }),
  };
  const promptFiles = { stage: vi.fn(async () => { note('stage'); return LINE; }) };
  const runtime = new TuiWorkerRuntime(workerInput as any, { startSignalStream: vi.fn() } as any, { start: vi.fn() } as any, { issueLaunch: vi.fn(() => undefined) } as any, '', promptFiles as any);
  const ctx = { server, handle: asPaneHandle('sess:1.1'), driver: tmux as any, supervisorTarget: 'sess:1', taskId: 99, unitId: 1, agentKind: kind };
  async function send(): Promise<unknown> {
    vi.useFakeTimers();
    try {
      const settled = runtime.sendPrompt(ctx, 'the prompt').then(() => null, (err: unknown) => err);
      await vi.advanceTimersByTimeAsync(40_000);
      return await settled;
    } finally {
      vi.useRealTimers();
    }
  }
  return { send, tmux, workerInput, promptFiles, pane, events };
}

describe('TuiWorkerRuntime.sendPrompt — nothing of the prompt is typed into a worker that cannot take it (#532)', () => {
  const PROMPT = 'do the task\n$(rm -rf ~)\n`id`; echo pwned';

  it.each([
    ['codex', 'codex_update_prompt', 'Update available! 0.149.1 -> 0.164.0\n1. Update now\n2. Skip\n3. Skip until next version'],
    ['codex', 'codex_trust_prompt', 'Do you trust the contents of this directory?\n1. Yes, continue\n2. No, quit'],
    ['claude', 'trust_dialog', 'Do you trust this folder?'],
    ['claude', 'bypass_permissions_dialog', 'WARNING: Claude Code running in Bypass Permissions mode\n1. No, exit\n2. Yes, I accept'],
  ] as const)('a %s worker showing %s: fails with the reason and sends nothing', async (kind, reason, screen) => {
    const h = sendHarness(kind, { idle: screen });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason });
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
    expect(h.workerInput.sendPrompt).not.toHaveBeenCalled();
    expect(h.promptFiles.stage).not.toHaveBeenCalled();
  });

  it('does not read the screen of a generic worker, and sends the line and Enter together', async () => {
    const { runtime, tmux, workerInput } = makeRuntime([''], 'some-tool');
    await runtime.sendPrompt({ server, handle: asPaneHandle('sess:1.1'), driver: tmux as any, supervisorTarget: 'sess:1', taskId: 1, unitId: 1, agentKind: null }, PROMPT);
    expect(tmux.captureScreen).not.toHaveBeenCalled();
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('TuiWorkerRuntime.sendPrompt — the worker has to be at an empty input (#532)', () => {
  it.each([
    ['codex', 'an unknown screen', 'Welcome to Codex\n  1. Sign in with ChatGPT\n  2. Provide your own API key'],
    ['codex', 'an empty screen', ''],
    ['claude', 'an unknown screen', 'Choose the text style that looks best with your terminal\n❯ 1. Dark mode\n  2. Light mode'],
    ['claude', 'an empty screen', '\n\n'],
    ['claude', 'the status line without an input box', 'bypass permissions on (shift+tab to cycle)'],
  ] as const)('a %s worker showing %s: refused after the grace, nothing sent and no prompt file written', async (kind, _name, screen) => {
    const h = sendHarness(kind, { idle: screen });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason: 'not_ready' });
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
    expect(h.promptFiles.stage).not.toHaveBeenCalled();
    expect(h.tmux.captureScreen.mock.calls.length).toBeGreaterThan(2);
  });

  it('an unknown screen whose choices look like a composer is refused as well, with nothing sent', async () => {
    const h = sendHarness('codex', { idle: 'Welcome to Codex\n› 1. Sign in with ChatGPT\n  2. Provide your own API key' });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError' });
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
    expect(h.promptFiles.stage).not.toHaveBeenCalled();
  });

  it('a pane that is back at a shell is refused at once, before the prompt file is written', async () => {
    const h = sendHarness('codex', { idle: 'user@host:~/wt$ ', foreground: 'bash' });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason: 'worker_exited_to_shell' });
    expect(h.promptFiles.stage).not.toHaveBeenCalled();
  });

  it.each([
    ['codex', 'a person\'s draft', 'codex-0.164-win-draft.txt'],
    ['codex', 'our line left from an earlier prompt, wrapped over three lines', 'codex-0.164-win-pending.txt'],
    ['claude', 'our line typed and not submitted', 'claude-2.1.310-linux-typed-not-submitted.txt'],
  ] as const)('a %s input that holds %s: refused with input_not_empty, no file and nothing typed', async (kind, _name, file) => {
    const h = sendHarness(kind, { idle: fixture(file) });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason: 'input_not_empty' });
    expect(h.promptFiles.stage).not.toHaveBeenCalled();
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
  });

  it('a screen that is still drawing gets the grace: the line is sent once the empty input shows', async () => {
    const h = sendHarness('codex', {});
    const first = h.tmux.captureScreen.getMockImplementation()!;
    let calls = 0;
    h.tmux.captureScreen.mockImplementation(async () => (++calls <= 2 ? { stdout: '' } : first()));
    expect(await h.send()).toBeNull();
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('a screen that changes into a dialog while the prompt file is being written is refused: the file exists, nothing is typed', async () => {
    const h = sendHarness('codex', {});
    const update = 'Update available! 0.149.1 -> 0.164.0\n1. Update now\n2. Skip\n3. Skip until next version';
    const normal = h.tmux.captureScreen.getMockImplementation()!;
    let calls = 0;
    h.tmux.captureScreen.mockImplementation(async () => (++calls === 1 ? normal() : { stdout: update }));
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason: 'codex_update_prompt' });
    expect(h.promptFiles.stage).toHaveBeenCalledTimes(1);
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
  });
});

describe('TuiWorkerRuntime.sendPrompt — the line has to be drawn, submitted and taken (#532)', () => {
  it('types, waits for the line to show in the input, waits the agent\'s submit delay, presses Enter, and is done when the input is empty', async () => {
    const h = sendHarness('codex', { drawDelayMs: 600 });
    expect(await h.send()).toBeNull();
    const at = (what: string) => h.events.find((e) => e.what === what)!.at;
    expect(h.events.map((e) => e.what)).toEqual(['stage', 'type', 'enter']);
    // not before the text was drawn (600 ms after it was typed), and not sooner than the submit delay after that
    expect(at('enter') - at('type')).toBeGreaterThanOrEqual(600);
    expect(h.pane.submitted).toEqual([LINE]);
    expect(h.workerInput.sendPrompt).not.toHaveBeenCalled();
  });

  it('presses Enter at once for claude (no submit delay) once the line shows', async () => {
    const h = sendHarness('claude', {});
    expect(await h.send()).toBeNull();
    const at = (what: string) => h.events.find((e) => e.what === what)!.at;
    expect(at('enter') - at('type')).toBeLessThan(400);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('waits the profile\'s 200 ms for codex even when the text is drawn at once', async () => {
    const h = sendHarness('codex', {});
    await h.send();
    const at = (what: string) => h.events.find((e) => e.what === what)!.at;
    expect(at('enter') - at('type')).toBeGreaterThanOrEqual(200);
  });

  it('stops with prompt_not_typed, pressing no Enter, when the line never shows in the input', async () => {
    const h = sendHarness('codex', { typed: workerScreenWith('') });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason: 'prompt_not_typed' });
    expect(h.workerInput.submitPrompt).not.toHaveBeenCalled();
  });

  it('presses Enter once more (not the prompt again) when the first Enter is not a submit, and is done when that submits it', async () => {
    const h = sendHarness('codex', { enterIgnored: 1 });
    expect(await h.send()).toBeNull();
    expect(h.workerInput.submitPrompt).toHaveBeenCalledTimes(2);
    expect(h.workerInput.typePrompt).toHaveBeenCalledTimes(1);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it.each(['codex', 'claude'] as const)('stops the task with prompt_not_submitted when a %s input still holds the line after the second Enter', async (kind) => {
    const h = sendHarness(kind, { enterIgnored: 99 });
    const err = await h.send();
    expect(err).toMatchObject({ name: 'TuiNotReadyError', reason: 'prompt_not_submitted' });
    expect(h.workerInput.submitPrompt).toHaveBeenCalledTimes(2);
    expect(workerNotReadyReason(err)).toBe('worker_not_ready: prompt_not_submitted');
  });

  it('stops with input_state_unknown, not as a success, when the input cannot be read until the end', async () => {
    const h = sendHarness('codex', { submitted: 'a screen without any composer' });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason: 'input_state_unknown' });
  });

  // What the screen is after the Enter: the line is gone from the input in every one of these, whatever else is on the screen.
  it.each([
    ['codex', 'right after the submit (echo, working line and an empty composer)', 'codex-0.164-win-just-submitted.txt'],
    ['codex', 'after the reply', 'codex-0.164-win-after-reply.txt'],
    ['codex', 'after a short reply', `› ${LINE}\n\n• Done.\n\n› Ask Codex to do anything\n\n  GPT-6.1-Sol default · ~\\repo\n  ? for shortcuts`],
    ['claude', 'right after the submit (echo with ❯, spinner without "esc to interrupt")', 'claude-2.1.310-linux-after-submit.txt'],
    ['claude', 'while it works', 'claude-2.1.310-linux-working.txt'],
    ['claude', 'when it is done', 'claude-2.1.310-win-idle-after-done.txt'],
    ['claude', 'after a short reply', `❯ ${LINE}\n● Done.\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  bypass permissions on (shift+tab to cycle)`],
  ] as const)('a %s worker %s: taken, no Enter is sent again', async (kind, _when, source) => {
    const submitted = source.endsWith('.txt') ? fixture(source) : source;
    const h = sendHarness(kind, { submitted });
    expect(await h.send()).toBeNull();
    expect(h.workerInput.submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('a screen that is taken from before the text was drawn does not end the check early (the first look finds the line)', async () => {
    // typed at once, but drawn 1 s later; the first captures after Enter would see an empty box if Enter were sent before the draw
    const h = sendHarness('codex', { drawDelayMs: 1000 });
    expect(await h.send()).toBeNull();
    expect(h.workerInput.submitPrompt).toHaveBeenCalledTimes(1);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('a supervised pane takes the line and Enter as one command; the check that it was taken still follows', async () => {
    const h = sendHarness('codex', { supervised: true });
    expect(await h.send()).toBeNull();
    expect(h.workerInput.sendPrompt).toHaveBeenCalledTimes(1);
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
  });
});

describe('workerNotReadyReason', () => {
  it('names a dialog, a worker back at a shell, and nothing else', () => {
    expect(workerNotReadyReason(new TuiNotReadyError('codex_update_prompt', ''))).toBe('worker_not_ready: codex_update_prompt');
    expect(workerNotReadyReason(new WorkerNotRunningError('bash'))).toBe('worker_not_ready: worker_exited_to_shell');
    expect(workerNotReadyReason(new Error('boom'))).toBeNull();
  });
});
