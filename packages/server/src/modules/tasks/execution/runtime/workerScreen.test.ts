import { describe, it, expect } from 'vitest';
import { blockingWorkerDialog, detectWorkerDialog, hasStalePromptInInput, isPromptPendingInInput, isWorkerScreenReady, tuiAgentKindOf, tuiAgentKindOfWorkerType } from './workerScreen';

describe('tuiAgentKindOf', () => {
  it('reads the agent from the launch line', () => {
    expect(tuiAgentKindOf('claude --dangerously-skip-permissions')).toBe('claude');
    expect(tuiAgentKindOf('codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false')).toBe('codex');
    expect(tuiAgentKindOf('/usr/bin/some-generic-tool')).toBeNull();
    expect(tuiAgentKindOf('codex exec claude-notes')).toBeNull();
  });
  it('reads the agent from the worker type', () => {
    expect(tuiAgentKindOfWorkerType('claude')).toBe('claude');
    expect(tuiAgentKindOfWorkerType('codex')).toBe('codex');
    expect(tuiAgentKindOfWorkerType('generic')).toBeNull();
    expect(tuiAgentKindOfWorkerType(null)).toBeNull();
  });
});

describe('codex screens', () => {
  const update = [
    '  ✨ Update available! 0.149.1 -> 0.164.0',
    '  Release notes: https://github.com/openai/codex/releases/latest',
    '› 1. Update now (runs `sh -c \'curl -fsSL https://chatgpt.com/codex/install.sh | sh\'`)',
    '  2. Skip',
    '  3. Skip until next version',
    '  Press enter to continue',
  ].join('\n');
  const trust149 = '  You are running Codex in /home/me/wt\n  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.\n› 1. Yes, continue\n  2. No, quit\n';
  const trust164 = '  Folder access\n  /home/me/wt\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit';
  const composer = '› Ask Codex to do anything\n\n  ? for shortcuts                                   100% context left';

  it('knows the update prompt, both trust screens, and the composer', () => {
    expect(detectWorkerDialog('codex', update)).toBe('codex_update_prompt');
    expect(detectWorkerDialog('codex', trust149)).toBe('codex_trust_prompt');
    expect(detectWorkerDialog('codex', trust164)).toBe('codex_trust_prompt');
    expect(detectWorkerDialog('codex', composer)).toBeNull();
  });

  it('is ready only at the composer, never on a dialog or an empty / shell screen', () => {
    expect(isWorkerScreenReady('codex', composer)).toBe(true);
    expect(isWorkerScreenReady('codex', 'working (3s • esc to interrupt)')).toBe(true);
    for (const screen of [update, trust149, trust164, '', 'user@host:~/wt$ ']) expect(isWorkerScreenReady('codex', screen)).toBe(false);
  });

  it('does not take Claude\'s trust screen for a codex one', () => {
    expect(detectWorkerDialog('codex', 'Do you trust this folder?\n1. Yes, proceed\n2. No, exit')).toBeNull();
  });

  it('names a dialog, and an unknown or empty screen is simply not ready (a sender must not go on with it)', () => {
    expect(blockingWorkerDialog('codex', update)).toBe('codex_update_prompt');
    expect(blockingWorkerDialog('codex', composer)).toBeNull();
    for (const screen of ['something unknown', '', '\n\n', 'Welcome to Codex\n› 1. Sign in with ChatGPT\n  2. Provide your own API key']) {
      expect(blockingWorkerDialog('codex', screen)).toBeNull();
      expect(isWorkerScreenReady('codex', screen)).toBe(false);
    }
  });

  // The conversation of a worker that develops AZITO itself quotes these sentences; the live composer below them says it is at its input.
  it('is not stopped by a conversation that quotes a dialog above a live composer (update, trust 0.149, trust 0.164)', () => {
    for (const quoted of [update, trust149, trust164]) {
      const screen = `• Earlier output:\n${quoted}\n\n${composer}`;
      expect(detectWorkerDialog('codex', screen)).toBeNull();
      expect(isWorkerScreenReady('codex', screen)).toBe(true);
      expect(blockingWorkerDialog('codex', screen)).toBeNull();
    }
  });

  it('is not stopped by a single quoted sentence of a dialog (the choices are not all there)', () => {
    for (const sentence of ['The UI says "Update available" in Settings', 'I pressed "Trust and continue" earlier', 'Do you trust the contents of this directory? is asked once']) {
      expect(detectWorkerDialog('codex', sentence)).toBeNull();
    }
  });

  it('is a dialog when it is below an old composer in the scrollback', () => {
    expect(detectWorkerDialog('codex', `${composer}\n\n${update}`)).toBe('codex_update_prompt');
    expect(detectWorkerDialog('codex', `${composer}\n\n${trust164}`)).toBe('codex_trust_prompt');
    expect(isWorkerScreenReady('codex', `${composer}\n\n${update}`)).toBe(false);
  });
});

describe('claude screens', () => {
  it('keeps the existing rules: a ready status line wins over a quoted dialog sentence', () => {
    const screen = 'Earlier we discussed: Do you trust this folder?\nbypass permissions on (shift+tab to cycle)';
    expect(isWorkerScreenReady('claude', screen)).toBe(true);
    expect(blockingWorkerDialog('claude', screen)).toBeNull();
  });
  const bypassDialog = [
    '╭──────────────────────────────────────────────╮',
    '│ WARNING: Claude Code running in Bypass Permissions mode',
    '│ By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
    '│ ❯ 1. No, exit',
    '│   2. Yes, I accept',
    '╰──────────────────────────────────────────────╯',
  ].join('\n');

  it('is not stopped by a conversation that quotes the whole Bypass Permissions dialog above the live status line or the working line', () => {
    for (const live of ['bypass permissions on (shift+tab to cycle)', 'Working (12s · esc to interrupt)']) {
      const screen = `● The dialog looked like this:\n${bypassDialog}\n\n${live}`;
      expect(detectWorkerDialog('claude', screen)).toBeNull();
      expect(isWorkerScreenReady('claude', screen)).toBe(true);
      expect(blockingWorkerDialog('claude', screen)).toBeNull();
    }
  });

  it('is stopped by the Bypass Permissions dialog itself, also under an old status line in the scrollback', () => {
    expect(blockingWorkerDialog('claude', bypassDialog)).toBe('bypass_permissions_dialog');
    const old = `bypass permissions on (shift+tab to cycle)\n\n${bypassDialog}`;
    expect(isWorkerScreenReady('claude', old)).toBe(false);
    expect(blockingWorkerDialog('claude', old)).toBe('bypass_permissions_dialog');
  });

  it('is not stopped by a quoted trust dialog above the live status line, and is by the dialog itself', () => {
    const trust = 'Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit';
    expect(blockingWorkerDialog('claude', `● Earlier:\n${trust}\n\nbypass permissions on (shift+tab to cycle)`)).toBeNull();
    expect(blockingWorkerDialog('claude', trust)).toBe('trust_dialog');
    expect(blockingWorkerDialog('claude', `bypass permissions on (shift+tab to cycle)\n${trust}`)).toBe('trust_dialog');
  });

  it('stops on the trust dialog', () => {
    expect(blockingWorkerDialog('claude', 'Do you trust this folder?')).toBe('trust_dialog');
  });
});

describe('a one-line prompt instruction left in the input (#532)', () => {
  const LINE = 'AZITO prompt file. Read the file named at the end of this line and carry out every instruction in it exactly: /tmp/azito-prompt-4-0123456789abcdef.md';
  const footer = '  ? for shortcuts                                   100% context left';

  it('is found in codex\'s input, also when the pane wrapped the long line anywhere', () => {
    expect(isPromptPendingInInput('codex', `› ${LINE}\n\n${footer}`, LINE)).toBe(true);
    const wrapped = `› AZITO prompt file. Read the file named at the end of this li\n  ne and carry out every instruction in it exactly: /tmp/azito-prom\n  pt-4-0123456789abcdef.md\n\n${footer}`;
    expect(isPromptPendingInInput('codex', wrapped, LINE)).toBe(true);
    expect(isPromptPendingInInput('codex', wrapped)).toBe(true);
  });

  it('is found in claude\'s input box', () => {
    expect(isPromptPendingInInput('claude', `╭──────╮\n│ > ${LINE} │\n╰──────╯\n  bypass permissions on (shift+tab to cycle)`, LINE)).toBe(true);
  });

  it('is not found once the worker works on it, or answered it and shows its empty composer', () => {
    expect(isPromptPendingInInput('codex', `› ${LINE}\n\n• Working (2s • esc to interrupt)\n${footer}`, LINE)).toBe(false);
    expect(isPromptPendingInInput('codex', `› ${LINE}\n\n• Done.\n\n› Ask Codex to do anything\n${footer}`, LINE)).toBe(false);
    expect(isPromptPendingInInput('claude', `> ${LINE}\n\n● Reading the file\n  esc to interrupt\n  bypass permissions on`, LINE)).toBe(false);
  });

  it('is not found for another prompt\'s line, for no line, or for a line far above a long reply', () => {
    expect(isPromptPendingInInput('codex', `› ${LINE}\n\n${footer}`, LINE.replace('0123456789abcdef', 'fedcba9876543210'))).toBe(false);
    expect(isPromptPendingInInput('codex', `${LINE.slice(0, 20)} but nothing else\n${footer}`, LINE)).toBe(false);
    expect(isPromptPendingInInput('codex', `› ${LINE}\n${'The plan has many steps and each is described in detail. '.repeat(20)}\n${footer}`, LINE)).toBe(false);
  });

  it('is looked for as a stale line in codex\'s input only', () => {
    expect(hasStalePromptInInput('codex', `› ${LINE}\n\n${footer}`)).toBe(true);
    expect(hasStalePromptInInput('codex', `› Ask Codex to do anything\n${footer}`)).toBe(false);
    expect(hasStalePromptInInput('claude', `> ${LINE}\n  bypass permissions on`)).toBe(false);
  });
});
