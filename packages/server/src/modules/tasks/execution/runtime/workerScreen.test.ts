import { describe, it, expect } from 'vitest';
import { blockingWorkerDialog, detectWorkerDialog, isWorkerScreenReady, tuiAgentKindOf, tuiAgentKindOfWorkerType } from './workerScreen';

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

  it('blocks on a dialog only', () => {
    expect(blockingWorkerDialog('codex', update)).toBe('codex_update_prompt');
    expect(blockingWorkerDialog('codex', 'something unknown')).toBeNull();
    expect(blockingWorkerDialog('codex', composer)).toBeNull();
  });
});

describe('claude screens', () => {
  it('keeps the existing rules: a ready status line wins over a quoted dialog sentence', () => {
    const screen = 'Earlier we discussed: Do you trust this folder?\nbypass permissions on (shift+tab to cycle)';
    expect(isWorkerScreenReady('claude', screen)).toBe(true);
    expect(blockingWorkerDialog('claude', screen)).toBeNull();
  });
  it('stops on the trust dialog', () => {
    expect(blockingWorkerDialog('claude', 'Do you trust this folder?')).toBe('trust_dialog');
  });
});
