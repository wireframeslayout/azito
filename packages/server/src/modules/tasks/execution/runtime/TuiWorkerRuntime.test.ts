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
  /** The pane has no "Worked for" line (a session just started). */
  quiet?: boolean;
  /** Ctrl+U does not clear the input. */
  cannotClear?: boolean;
  /** The pane wraps its input at this width, and Ctrl+U clears one display line of it (Claude Code). */
  wrapWidth?: number;
  clearsOneLine?: boolean;
  /** The first captures, whatever else is set (a screen that is still changing). */
  firstScreens?: string[];
}

/** The real runtime over a pane that reacts to the keys the way a TUI does, under fake timers. */
function sendHarness(kind: 'claude' | 'codex', options: HarnessOptions = {}) {
  const pane = createFakeWorkerPane({ wrapWidth: options.wrapWidth, clearsOneLine: options.clearsOneLine, onlyClaude: options.wrapWidth !== undefined, quiet: options.quiet });
  const events: Array<{ what: string; at: number }> = [];
  const state = { typedAt: -1, submits: 0, enterIgnored: options.enterIgnored ?? 0 };
  const note = (what: string) => events.push({ what, at: Date.now() });
  const firstScreens = [...(options.firstScreens ?? [])];
  const screen = (): string => {
    if (firstScreens.length > 0) return firstScreens.shift()!;
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
    clearInputLine: vi.fn(async () => { note('clear'); if (!options.cannotClear) pane.clear(); }),
    typePrompt: vi.fn(async (_s: unknown, _h: unknown, text: string, _ctx?: unknown, _target?: unknown) => { state.typedAt = Date.now(); note('type'); pane.sendKeys([text]); }),
    submitPrompt: vi.fn(async (_s: unknown, _h: unknown, _ctx?: unknown, _target?: unknown) => {
      note('enter');
      state.submits++;
      if (state.enterIgnored > 0) { state.enterIgnored--; state.submits--; state.submits = Math.max(state.submits, 0); return; }
      pane.sendKeys(['Enter']);
    }),
  };
  const promptFiles = { stage: vi.fn(async () => { note('stage'); return LINE; }) };
  const runtime = new TuiWorkerRuntime(workerInput as any, { startSignalStream: vi.fn() } as any, { start: vi.fn() } as any, { issueLaunch: vi.fn(() => undefined) } as any, '', promptFiles as any);
  const ctx = { server, handle: asPaneHandle('sess:1.1'), driver: tmux as any, supervisorTarget: 'sess:1', taskId: 99, unitId: 1, agentKind: kind };
  let settledAt = 0;
  let startedAt = 0;
  async function send(): Promise<unknown> {
    vi.useFakeTimers();
    startedAt = Date.now();
    try {
      const settled = runtime.sendPrompt(ctx, 'the prompt').then(() => { settledAt = Date.now(); return null; }, (err: unknown) => { settledAt = Date.now(); return err; });
      await vi.advanceTimersByTimeAsync(120_000);
      return await settled;
    } finally {
      vi.useRealTimers();
    }
  }
  return { send, tmux, workerInput, promptFiles, pane, events, waitedMs: () => settledAt - startedAt };
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

  it('a Claude input that shows "Press up to edit queued messages" is empty, but the turn is still running: ours waits for the turn to end', async () => {
    const queued = fixture('claude-2.1.310-linux-queued-placeholder.txt');
    const h = sendHarness('claude', { firstScreens: [queued, queued, queued] });
    expect(await h.send()).toBeNull();
    expect(h.workerInput.typePrompt).toHaveBeenCalledTimes(1);
    expect(h.tmux.captureScreen.mock.calls.length).toBeGreaterThan(3);
  });

  it.each([
    ['codex', 'codex-0.163-linux-working-empty.txt'],
    ['codex', 'codex-0.163-linux-working-queued.txt'],
    ['claude', 'claude-2.1.310-linux-working.txt'],
    ['claude', 'claude-2.1.310-linux-queued-placeholder.txt'],
  ] as const)('a %s worker whose turn does not end (%s): stops with worker_busy after 60 s, sending and writing nothing', async (kind, file) => {
    const h = sendHarness(kind, { idle: fixture(file) });
    expect(await h.send()).toMatchObject({ name: 'TuiNotReadyError', reason: 'worker_busy' });
    expect(h.promptFiles.stage).not.toHaveBeenCalled();
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
  });

  it('a codex worker whose turn ends while it is waited for gets the prompt', async () => {
    const working = fixture('codex-0.163-linux-working-empty.txt');
    const h = sendHarness('codex', { firstScreens: [working, working, working, working] });
    expect(await h.send()).toBeNull();
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('a turn that never ends after the file was written stops the task with worker_busy after 60 s of waiting, before anything is typed; the file stays (it is a task temp file that is cleaned up)', async () => {
    const h = sendHarness('codex', {});
    const normal = h.tmux.captureScreen.getMockImplementation()!;
    h.tmux.captureScreen.mockImplementation(async () => (h.promptFiles.stage.mock.calls.length === 0 ? normal() : { stdout: fixture('codex-0.163-linux-working-empty.txt') }));
    expect(await h.send()).toMatchObject({ reason: 'worker_busy' });
    expect(h.workerInput.typePrompt).not.toHaveBeenCalled();
    expect(h.promptFiles.stage).toHaveBeenCalledTimes(1);
  });

  it('a turn that starts while the file is written is waited for, within the same 60 s, not a reason to stop at once; the file is written once', async () => {
    const h = sendHarness('codex', {});
    const normal = h.tmux.captureScreen.getMockImplementation()!;
    const working = fixture('codex-0.163-linux-working-empty.txt');
    let looksAfterStage = 0;
    h.tmux.captureScreen.mockImplementation(async () => {
      if (h.promptFiles.stage.mock.calls.length === 0) return normal();
      return ++looksAfterStage <= 6 ? { stdout: working } : normal();
    });
    expect(await h.send()).toBeNull();
    expect(h.promptFiles.stage).toHaveBeenCalledTimes(1);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('worker_busy is thrown only after the time was really waited (60 s)', async () => {
    const h = sendHarness('codex', { idle: fixture('codex-0.163-linux-working-empty.txt') });
    expect(await h.send()).toMatchObject({ reason: 'worker_busy' });
    expect(h.waitedMs()).toBeGreaterThanOrEqual(60_000);
    expect(h.waitedMs()).toBeLessThan(62_000);
  });

  // codex hides its status line while it streams the final answer (the screen above the input changes at every frame) and in the gaps
  // between two tool calls (a frame or two): neither is a turn that is over.
  it('a codex worker streaming its final answer (no status line, the screen changing) is waited for until the screen has settled', async () => {
    const stream = (n: number) => fixture('codex-0.163-linux-streaming-final-answer.txt').replace('TCP congestion control adjusts', `TCP congestion control adjusts ${'word '.repeat(n)}`);
    const h = sendHarness('codex', { firstScreens: Array.from({ length: 20 }, (_, i) => stream(i)) });
    expect(await h.send()).toBeNull();
    const at = (what: string) => h.events.find((e) => e.what === what)!.at;
    expect(h.tmux.captureScreen.mock.calls.length).toBeGreaterThan(20);
    expect(at('type')).toBeGreaterThan(0);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('the gaps between tool calls (a frame without the status line) are not the end of the turn', async () => {
    const gap1 = fixture('codex-0.163-linux-between-tools-1.txt');
    const gap2 = fixture('codex-0.163-linux-between-tools-2.txt');
    const working = fixture('codex-0.163-linux-working-empty.txt');
    const h = sendHarness('codex', { firstScreens: [gap1, working, working, gap2, working, working, gap1, working] });
    expect(await h.send()).toBeNull();
    // the prompt was typed after the last frame of the sequence: the gaps did not let it in
    expect(h.tmux.captureScreen.mock.calls.length).toBeGreaterThan(8);
  });

  // codex stops in the middle of an answer for 2 s now and then (cap7/stall-*): a screen that is quiet is not a turn that is over, once a turn was seen
  it('changing -> quiet for 2 s mid-sentence -> changing -> "Worked for": the prompt waits for the "Worked for" line', async () => {
    const streaming = (n: number) => fixture('codex-0.163-linux-streaming-final-answer.txt').replace('TCP congestion control adjusts', `TCP congestion control adjusts ${'word '.repeat(n)}`);
    const stall = fixture('codex-0.163-linux-answer-stalled-mid-sentence-1.txt');
    const screens = [streaming(1), streaming(2), streaming(3), ...Array.from({ length: 6 }, () => stall), streaming(4), streaming(5)];
    const h = sendHarness('codex', { firstScreens: screens, idle: fixture('codex-0.164-win-after-reply.txt') });
    expect(await h.send()).toBeNull();
    // the stall (6 looks, 2.5 s) did not let the prompt in: it was typed only after every one of the screens had been looked at
    expect(h.tmux.captureScreen.mock.calls.length).toBeGreaterThan(screens.length);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  // Windows, codex 0.164 (win-codex-busy-stop): the start-up (banner, MCP, a warning row) changes the screen; no prompt has been sent yet
  it('a codex session that has only just started (its screen changing while it starts, then quiet, no "Worked for") is sent the prompt after the 5 s quiet time, not after 60 s', async () => {
    const started = fixture('codex-0.164-win-just-started.txt');
    const starting = (n: number) => started.replace('permissions: YOLO mode', `permissions: YOLO mode\n  starting MCP servers (${n}/3)`);
    const h = sendHarness('codex', { firstScreens: [starting(0), starting(1), starting(2), starting(3)], idle: started });
    expect(await h.send()).toBeNull();
    expect(h.waitedMs()).toBeLessThan(15_000);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('a turn that was seen and never writes "Worked for" (stopped, an error) is waited for 60 s and then worker_busy', async () => {
    const streaming = (n: number) => fixture('codex-0.163-linux-streaming-final-answer.txt').replace('TCP congestion control adjusts', `TCP congestion control adjusts ${'word '.repeat(n)}`);
    const h = sendHarness('codex', { firstScreens: [streaming(1), streaming(2), streaming(3)], quiet: true });
    expect(await h.send()).toMatchObject({ reason: 'worker_busy' });
    expect(h.waitedMs()).toBeGreaterThanOrEqual(60_000);
    expect(h.promptFiles.stage).not.toHaveBeenCalled();
  });

  it('a codex worker that wrote its "Worked for" line is free at once; one with no turn on the screen waits for it to be quiet (5 s)', async () => {
    const t0 = Date.now();
    const over = sendHarness('codex', { idle: fixture('codex-0.164-win-after-reply.txt') });
    expect(await over.send()).toBeNull();
    expect(over.events.find((e) => e.what === 'stage')!.at - t0).toBeLessThan(500);
    const t1 = Date.now();
    const noMarker = sendHarness('codex', { quiet: true });
    expect(await noMarker.send()).toBeNull();
    expect(noMarker.events.find((e) => e.what === 'stage')!.at - t1).toBeGreaterThanOrEqual(5000);
  });

  it('input_state_unknown after the Enter goes through the cleanup: our line is cleared when the screen can be read again, else the message says the input could not be read', async () => {
    const rule = '─'.repeat(60);
    const unreadable = `${rule}\n❯ an earlier message\n${rule}\n\n● reply\n\n${rule}\n❯ ${LINE}\n${'─'.repeat(25)} ${'─'.repeat(25)}\n  bypass permissions on (shift+tab to cycle)`;

    // never readable: nothing is cleared, and the message says to look at the input
    const never = sendHarness('claude', { submitted: unreadable });
    const unreadableErr = await never.send();
    expect(unreadableErr).toMatchObject({ reason: 'input_state_unknown', inputLeft: true, inputUnreadable: true });
    expect((unreadableErr as Error).message).toMatch(/入力欄を確かめてから再開してください/);
    expect((unreadableErr as Error).message).not.toMatch(/消してから再開/);
    expect(never.workerInput.clearInputLine).not.toHaveBeenCalled();

    // readable again at the look after the wait (no time passes between the last look of the wait and it), with our line in the box
    const again = sendHarness('claude', {});
    const normal = again.tmux.captureScreen.getMockImplementation()!;
    let lastLookAt = -1;
    let readableAgain = false;
    again.tmux.captureScreen.mockImplementation(async () => {
      if (again.workerInput.submitPrompt.mock.calls.length === 0) return normal();
      if (Date.now() === lastLookAt) readableAgain = true;
      lastLookAt = Date.now();
      return readableAgain ? { stdout: `${rule}\n❯ ${LINE}\n${rule}\n  bypass permissions on (shift+tab to cycle)` } : { stdout: unreadable };
    });
    const readableErr = await again.send();
    expect(readableErr).toMatchObject({ reason: 'input_state_unknown', inputLeft: true, inputUnreadable: false });
    expect(again.workerInput.clearInputLine).toHaveBeenCalled();
    expect((readableErr as Error).message).toMatch(/消してから再開/);
  });

  it('Claude: a broken lower rule after Enter (right until the line was drawn) does not end the check as a success', async () => {
    // seen before Enter: a clean pair of rules holding our line; after Enter: the history's old rule pair + a past message are all that can be read
    const rule = '─'.repeat(60);
    const broken = `${rule}\n❯ an earlier message\n${rule}\n\n● reply\n\n${rule}\n❯ ${LINE}\n${'─'.repeat(25)} ${'─'.repeat(25)}\n  bypass permissions on (shift+tab to cycle)`;
    const h = sendHarness('claude', { submitted: broken });
    const err = await h.send();
    expect(err).toMatchObject({ name: 'TuiNotReadyError', reason: 'input_state_unknown' });
    expect(h.workerInput.submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('an input that reads as text for a moment (a wording not known yet) gets the grace before the task is stopped', async () => {
    const rule = '─'.repeat(60);
    const unknownHint = `${rule}\n❯ Some new hint of an empty input\n${rule}\n  bypass permissions on (shift+tab to cycle)`;
    const h = sendHarness('claude', { firstScreens: [unknownHint, unknownHint] });
    expect(await h.send()).toBeNull();
    const stuck = sendHarness('claude', { idle: unknownHint });
    expect(await stuck.send()).toMatchObject({ reason: 'input_not_empty' });
    expect(stuck.promptFiles.stage).not.toHaveBeenCalled();
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
    // normal until the prompt file is written, then the update prompt
    h.tmux.captureScreen.mockImplementation(async () => (h.promptFiles.stage.mock.calls.length === 0 ? normal() : { stdout: update }));
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
    // the line the task typed is taken back, so nothing submits it later
    expect(h.workerInput.clearInputLine).toHaveBeenCalledTimes(1);
    expect(h.pane.screen()).toContain('Ask Codex to do anything');
    expect((err as Error).message).not.toMatch(/消してから再開/);
  });

  it('says to clear the input before resuming when the line could not be taken back', async () => {
    const h = sendHarness('codex', { enterIgnored: 99, cannotClear: true });
    const err = await h.send();
    expect(err).toMatchObject({ name: 'TuiNotReadyError', reason: 'prompt_not_submitted', inputLeft: true });
    expect((err as Error).message).toMatch(/入力欄に残った 1 行を消してから再開してください/);
    expect(h.workerInput.clearInputLine).toHaveBeenCalledTimes(5);
  });

  it('keeps clearing while text is left: Claude Code clears one display line of a wrapped input per Ctrl+U', async () => {
    const h = sendHarness('claude', { enterIgnored: 99, wrapWidth: 40, clearsOneLine: true });
    const err = await h.send();
    expect(err).toMatchObject({ reason: 'prompt_not_submitted', inputLeft: false });
    expect((err as Error).message).not.toMatch(/消してから再開/);
    expect(h.workerInput.clearInputLine.mock.calls.length).toBeGreaterThan(1);
    expect(h.pane.screen()).toContain('❯ \n');
  });

  it('gives up after five Ctrl+U and says to clear the rest when the input is still not empty', async () => {
    const h = sendHarness('claude', { enterIgnored: 99, wrapWidth: 10, clearsOneLine: true });
    const err = await h.send();
    expect(err).toMatchObject({ reason: 'prompt_not_submitted', inputLeft: true });
    expect(h.workerInput.clearInputLine).toHaveBeenCalledTimes(5);
  });

  it('prompt_not_typed: the screen is read again, and an input that is not empty (or cannot be read) is reported as left', async () => {
    // never drawn into the first look; a draft of a person is in the input on the second look
    const h = sendHarness('codex', { typed: fixture('codex-0.164-win-draft.txt') });
    const err = await h.send();
    expect(err).toMatchObject({ reason: 'prompt_not_typed', inputLeft: true });
    expect(h.workerInput.clearInputLine).not.toHaveBeenCalled();
    const empty = sendHarness('codex', { typed: workerScreenWith('') });
    expect(await empty.send()).toMatchObject({ reason: 'prompt_not_typed', inputLeft: false });
    const unreadable = sendHarness('codex', { typed: 'a screen without any composer' });
    expect(await unreadable.send()).toMatchObject({ reason: 'prompt_not_typed', inputLeft: true });
  });

  // An error that is none of the checks' (here: the screen cannot be read once, after the line was typed) must not leave the line in the input.
  it('a look at the screen that fails after the line was typed: the screen is looked at again, our line is cleared, the original error is kept', async () => {
    const h = sendHarness('codex', {});
    const real = h.tmux.captureScreen.getMockImplementation()!;
    let failed = false;
    h.tmux.captureScreen.mockImplementation(async () => {
      if (h.workerInput.typePrompt.mock.calls.length > 0 && !failed) {
        failed = true;
        throw new Error('capture-pane failed');
      }
      return real();
    });
    const err = await h.send();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('capture-pane failed');
    expect(h.workerInput.submitPrompt).not.toHaveBeenCalled();
    expect(h.workerInput.clearInputLine).toHaveBeenCalledTimes(1);
    expect(h.pane.screen()).toContain('Ask Codex to do anything');
  });

  it('a key that fails to go (the Enter): the input is cleaned up the same way, and a line that cannot be cleared is reported with the original error as the cause', async () => {
    const h = sendHarness('codex', { cannotClear: true });
    h.workerInput.submitPrompt.mockRejectedValue(new Error('send-keys failed'));
    const err = await h.send();
    expect((err as Error).message).toMatch(/^send-keys failed。入力欄に残った 1 行を消してから再開してください/);
    expect(((err as Error).cause as Error).message).toBe('send-keys failed');
    expect(h.workerInput.clearInputLine).toHaveBeenCalledTimes(5);
  });

  it('when the screen cannot be read again either, the original error says that the input could not be checked', async () => {
    const h = sendHarness('codex', {});
    const real = h.tmux.captureScreen.getMockImplementation()!;
    h.tmux.captureScreen.mockImplementation(async () => {
      if (h.workerInput.typePrompt.mock.calls.length > 0) throw new Error('capture-pane failed');
      return real();
    });
    const err = await h.send();
    expect((err as Error).message).toMatch(/^capture-pane failed。入力欄の状態を確かめられませんでした/);
    expect(h.workerInput.clearInputLine).not.toHaveBeenCalled();
  });

  it('does not clear an input that does not hold the task\'s line (a person\'s draft is never touched)', async () => {
    const h = sendHarness('codex', { typed: workerScreenWith('') });
    expect(await h.send()).toMatchObject({ reason: 'prompt_not_typed' });
    expect(h.workerInput.clearInputLine).not.toHaveBeenCalled();
    const draft = sendHarness('codex', { idle: fixture('codex-0.164-win-draft.txt') });
    expect(await draft.send()).toMatchObject({ reason: 'input_not_empty' });
    expect(draft.workerInput.clearInputLine).not.toHaveBeenCalled();
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

  it('the Enter is not sent on the first, still empty look after the line was typed (a pane that draws it late, under a supervisor too)', async () => {
    // before: empty, empty; after the line was typed: empty, then the line shows
    const h = sendHarness('codex', { drawDelayMs: 700 });
    expect(await h.send()).toBeNull();
    const at = (what: string) => h.events.find((e) => e.what === what)!.at;
    expect(at('enter') - at('type')).toBeGreaterThanOrEqual(700);
    expect(h.workerInput.submitPrompt).toHaveBeenCalledTimes(1);
    expect(h.pane.submitted).toEqual([LINE]);
  });

  it('hands the supervisor target to the typing and to the Enter', async () => {
    const h = sendHarness('claude', {});
    await h.send();
    expect(h.workerInput.typePrompt.mock.calls[0][4]).toBe('sess:1');
    expect(h.workerInput.submitPrompt.mock.calls[0][3]).toBe('sess:1');
  });
});

describe('workerNotReadyReason', () => {
  it('names a dialog, a worker back at a shell, and nothing else', () => {
    expect(workerNotReadyReason(new TuiNotReadyError('codex_update_prompt', ''))).toBe('worker_not_ready: codex_update_prompt');
    expect(workerNotReadyReason(new WorkerNotRunningError('bash'))).toBe('worker_not_ready: worker_exited_to_shell');
    expect(workerNotReadyReason(new Error('boom'))).toBeNull();
  });
});
