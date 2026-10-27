import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockingWorkerDialog, detectWorkerDialog, inputHoldsLine, isWorkerBusy, isWorkerScreenReady, readInputBox, showsTurnEnd, tuiAgentKindOf, tuiAgentKindOfWorkerType } from './workerScreen';

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

/** A screen taken from a real pane (see fixtures/): Claude Code 2.1.310 on Linux and Windows, codex 0.164.0 on Windows. */
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('readInputBox on the screens of real panes (#532)', () => {
  const LINE = 'AZITO prompt file. Read the file named at the end of this line and carry out every instruction in it exactly: C:/Users/SERVER~1/AppData/Local/Temp/azito-prompt-99-0123456789abcdef.md';

  describe('codex 0.164.0', () => {
    it('an empty composer is empty, also after a reply and right after a submit (the echo above it is history)', () => {
      expect(readInputBox('codex', fixture('codex-0.164-win-idle.txt'))).toEqual({ state: 'empty' });
      expect(readInputBox('codex', fixture('codex-0.164-win-after-reply.txt'))).toEqual({ state: 'empty' });
      expect(readInputBox('codex', fixture('codex-0.164-win-just-submitted.txt'))).toEqual({ state: 'empty' });
    });

    it('a person\'s draft is filled', () => {
      expect(readInputBox('codex', fixture('codex-0.164-win-draft.txt'))).toEqual({ state: 'filled', text: 'please check the logs' });
    });

    it('our line left in the input is filled, wrapped over three lines, and is told from other text by its file name', () => {
      const box = readInputBox('codex', fixture('codex-0.164-win-pending.txt'));
      expect(box.state).toBe('filled');
      expect(inputHoldsLine(box, LINE)).toBe(true);
      expect(inputHoldsLine(box, LINE.replace('0123456789abcdef', 'fedcba9876543210'))).toBe(false);
      expect(inputHoldsLine(readInputBox('codex', fixture('codex-0.164-win-draft.txt')), LINE)).toBe(false);
    });

    it('is ready when the composer is empty and not ready while our line sits in it (the footer is gone then)', () => {
      expect(isWorkerScreenReady('codex', fixture('codex-0.164-win-idle.txt'))).toBe(true);
      expect(isWorkerScreenReady('codex', fixture('codex-0.164-win-just-submitted.txt'))).toBe(true);
      expect(isWorkerScreenReady('codex', fixture('codex-0.164-win-pending.txt'))).toBe(false);
    });

    it('an overlay in place of the input is unknown: the `›` of the history (our echo) is not the input', () => {
      const screen = fixture('codex-0.163-locked-overlay.txt');
      expect(screen).toContain('› AZITO prompt file.');
      expect(screen).toContain('This conversation is open in another app');
      expect(readInputBox('codex', screen)).toEqual({ state: 'unknown' });
      expect(isWorkerScreenReady('codex', screen)).toBe(false);
    });

    it('a `›` message in the history above a real composer is not taken for the input', () => {
      expect(readInputBox('codex', fixture('codex-0.164-win-after-reply.txt'))).toEqual({ state: 'empty' });
    });

    it('knows "Input disabled", and an unknown screen is unknown, not empty', () => {
      expect(readInputBox('codex', '› Input disabled while the agent works\n\n  ? for shortcuts')).toEqual({ state: 'disabled' });
      expect(readInputBox('codex', 'some screen without a composer\nat all')).toEqual({ state: 'unknown' });
      expect(readInputBox('codex', '')).toEqual({ state: 'unknown' });
    });
  });

  describe('Claude Code 2.1.310', () => {
    it('the box between the last two rules is empty at rest, while working, and after it finished (a long history above it)', () => {
      for (const name of ['claude-2.1.310-win-idle-after-done.txt', 'claude-2.1.310-linux-working.txt', 'claude-2.1.310-linux-done.txt', 'claude-2.1.310-linux-after-submit.txt', 'claude-2.1.310-linux-just-submitted.txt']) {
        expect(readInputBox('claude', fixture(name)), name).toEqual({ state: 'empty' });
      }
    });

    it('the echo of a submitted message (it starts with ❯ too) is history, not the input', () => {
      const after = fixture('claude-2.1.310-linux-after-submit.txt');
      expect(after).toContain('❯ AZITO prompt file.');
      expect(readInputBox('claude', after)).toEqual({ state: 'empty' });
    });

    it('our line typed and not submitted is filled', () => {
      const box = readInputBox('claude', fixture('claude-2.1.310-linux-typed-not-submitted.txt'));
      expect(box.state).toBe('filled');
      expect(inputHoldsLine(box, 'AZITO prompt file. x: /tmp/azito-prompt-4-0123456789abcdef.md')).toBe(true);
    });

    it('the hint of an empty input ("Try ...") is empty, a draft is filled, a screen without a box is unknown', () => {
      const rule = '─'.repeat(60);
      expect(readInputBox('claude', `${rule}\n❯ Try "fix lint errors"\n${rule}\n  bypass permissions on (shift+tab to cycle)`)).toEqual({ state: 'empty' });
      expect(readInputBox('claude', `${rule}\n❯ check the logs\n${rule}\n  bypass permissions on (shift+tab to cycle)`)).toEqual({ state: 'filled', text: 'check the logs' });
      expect(readInputBox('claude', 'bypass permissions on (shift+tab to cycle)')).toEqual({ state: 'unknown' });
      expect(readInputBox('claude', '')).toEqual({ state: 'unknown' });
    });

    it('the queued-message placeholder of a busy turn is an empty input', () => {
      const screen = fixture('claude-2.1.310-linux-queued-placeholder.txt');
      expect(screen).toContain('Press up to edit queued messages');
      expect(readInputBox('claude', screen)).toEqual({ state: 'empty' });
    });

    it('an old empty frame in the history is not the input when the current input below it cannot be read', () => {
      const oldFrame = '╭────────╮\n│ >        │\n╰────────╯';
      // the current input has our line and a lower rule that is not one long run of ─
      const current = `❯ AZITO prompt file. x: /tmp/azito-prompt-4-0123456789abcdef.md\n${'─'.repeat(20)} ${'─'.repeat(20)}\n  bypass permissions on (shift+tab to cycle)`;
      expect(readInputBox('claude', `${oldFrame}\n\n● reply\n\n${current}`)).toEqual({ state: 'unknown' });
      expect(readInputBox('claude', `${oldFrame}\n\n● reply\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(20)} ${'─'.repeat(20)}\n  bypass permissions on (shift+tab to cycle)`)).toEqual({ state: 'unknown' });
    });

    it('reads Claude Code 2.0.x\'s framed box', () => {
      expect(readInputBox('claude', '╭────────╮\n│ >        │\n╰────────╯\n  bypass permissions on')).toEqual({ state: 'empty' });
      expect(readInputBox('claude', '╭────────╮\n│ > hello  │\n╰────────╯\n  bypass permissions on')).toEqual({ state: 'filled', text: 'hello' });
    });
  });
});

describe('a turn that is still running (#532)', () => {
  const LINE = 'AZITO prompt file. Read the file named at the end of this line and carry out every instruction in it exactly: /tmp/azr5/azito-prompt-9-83de1b3fccacce11.md';

  it('codex: the composer of a running turn is empty, a line typed into it is filled and ours (the hint row "tab to queue message" is part of the footer)', () => {
    expect(readInputBox('codex', fixture('codex-0.163-linux-working-empty.txt'))).toEqual({ state: 'empty' });
    expect(readInputBox('codex', fixture('codex-0.163-linux-working-queued.txt'))).toEqual({ state: 'empty' });
    expect(readInputBox('codex', fixture('codex-0.163-linux-working-draft.txt'))).toEqual({ state: 'filled', text: 'second message draft' });
    const typed = readInputBox('codex', fixture('codex-0.163-linux-working-typed-line.txt'));
    expect(typed.state).toBe('filled');
    expect(inputHoldsLine(typed, LINE)).toBe(true);
  });

  it('is busy while codex shows its working line above the composer, and not at rest, after the reply, or with a quoted line', () => {
    expect(isWorkerBusy('codex', fixture('codex-0.163-linux-working-empty.txt'))).toBe(true);
    expect(isWorkerBusy('codex', fixture('codex-0.163-linux-working-queued.txt'))).toBe(true);
    expect(isWorkerBusy('codex', fixture('codex-0.163-linux-working-typed-line.txt'))).toBe(true);
    expect(isWorkerBusy('codex', fixture('codex-0.164-win-idle.txt'))).toBe(false);
    expect(isWorkerBusy('codex', fixture('codex-0.164-win-after-reply.txt'))).toBe(false);
    expect(isWorkerBusy('codex', '• The worker prints "esc to interrupt" in a long answer\n' + Array.from({ length: 12 }, (_, i) => `  line ${i}`).join('\n') + '\n\n› Ask Codex to do anything\n\n  ? for shortcuts')).toBe(false);
  });

  it('a sentence of an answer that says "esc to interrupt" is not the status line, for codex or for Claude', () => {
    const answer = 'The status says "esc to interrupt" while a turn runs.';
    expect(isWorkerBusy('codex', `${answer}\n\n› Ask Codex to do anything\n\n  ? for shortcuts`)).toBe(false);
    expect(isWorkerBusy('codex', `  Worked for 5s • 8:24 AM\n${answer}\n\n› Ask Codex to do anything\n\n  ? for shortcuts`)).toBe(false);
    const rule = '─'.repeat(60);
    expect(isWorkerBusy('claude', `● ${answer}\n\n${rule}\n❯ \n${rule}\n  bypass permissions on (shift+tab to cycle)`)).toBe(false);
  });

  it('the status line is told by its shape: `Working (` after a bullet, and the glyph + word + … of Claude (also ✳)', () => {
    expect(isWorkerBusy('codex', '◦ Working (5s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  ? for shortcuts')).toBe(true);
    const rule = '─'.repeat(60);
    for (const glyph of ['·', '✢', '✳', '✶', '✻', '✽', '*']) {
      expect(isWorkerBusy('claude', `${glyph} Wrangling… (5s · ↓ 77 tokens)\n\n${rule}\n❯ \n${rule}\n  bypass permissions on (shift+tab to cycle)`), glyph).toBe(true);
    }
  });

  it('codex hides the status line while it streams the final answer and between tool calls: such a screen is not busy by its shape, and shows no turn end', () => {
    for (const name of ['codex-0.163-linux-streaming-final-answer.txt', 'codex-0.163-linux-between-tools-1.txt', 'codex-0.163-linux-between-tools-2.txt']) {
      expect(isWorkerBusy('codex', fixture(name)), name).toBe(false);
      expect(showsTurnEnd('codex', fixture(name)), name).toBe(false);
    }
    // a "Worked for" line of the turn before, far above, is not the end of this one
    expect(showsTurnEnd('codex', fixture('codex-0.163-linux-between-tools-1.txt'))).toBe(false);
  });

  it('"Worked for" counts only on the line right above the input (a background terminal note may follow it), not above the next prompt just sent', () => {
    const over = fixture('codex-0.163-linux-next-prompt-just-sent.txt');
    expect(over).toContain('Worked for 25s');
    expect(showsTurnEnd('codex', over)).toBe(false);
    const withNote = '  Worked for 6s • 9:44 AM\n  1 background terminal running · /ps to view · /stop to close\n\n› Ask Codex to do anything\n\n  ? for shortcuts';
    expect(showsTurnEnd('codex', withNote)).toBe(true);
    expect(showsTurnEnd('codex', `  Worked for 6s • 9:44 AM\n› Run something\n\n› Ask Codex to do anything\n\n  ? for shortcuts`)).toBe(false);
  });

  it('an answer that stalls in the middle of a sentence shows no status line and no turn end', () => {
    for (const name of ['codex-0.163-linux-answer-stalled-mid-sentence-1.txt', 'codex-0.163-linux-answer-stalled-mid-sentence-2.txt']) {
      expect(isWorkerBusy('codex', fixture(name)), name).toBe(false);
      expect(showsTurnEnd('codex', fixture(name)), name).toBe(false);
      expect(readInputBox('codex', fixture(name)), name).toEqual({ state: 'empty' });
    }
  });

  it('codex writes "Worked for ..." right above the input when the turn is over', () => {
    expect(showsTurnEnd('codex', fixture('codex-0.164-win-after-reply.txt'))).toBe(true);
    expect(showsTurnEnd('claude', fixture('claude-2.1.310-linux-done.txt'))).toBe(true);
  });

  it('is busy while Claude shows its spinner above the input (it has no "esc to interrupt" in 2.1.310), and not when the turn is done', () => {
    expect(isWorkerBusy('claude', fixture('claude-2.1.310-linux-working.txt'))).toBe(true);
    expect(isWorkerBusy('claude', fixture('claude-2.1.310-linux-queued-placeholder.txt'))).toBe(true);
    expect(isWorkerBusy('claude', fixture('claude-2.1.310-linux-after-submit.txt'))).toBe(true);
    expect(isWorkerBusy('claude', fixture('claude-2.1.310-linux-done.txt'))).toBe(false);
    expect(isWorkerBusy('claude', fixture('claude-2.1.310-win-idle-after-done.txt'))).toBe(false);
    expect(isWorkerBusy('claude', fixture('claude-2.1.310-linux-narrow-typed-wrapped.txt'))).toBe(false);
  });

  it('Claude: a lower rule that is not one clean run makes the pair unreadable (unknown), not a pair of the history', () => {
    const rule = '─'.repeat(60);
    const screen = `${rule}\n❯ an earlier message\n${rule}\n\n● reply\n\n${rule}\n❯ ${LINE}\n${'─'.repeat(25)} ${'─'.repeat(25)}\n  bypass permissions on (shift+tab to cycle)`;
    expect(readInputBox('claude', screen)).toEqual({ state: 'unknown' });
    expect(readInputBox('claude', fixture('claude-2.1.310-linux-typed-not-submitted.txt')).state).toBe('filled');
  });

  it('Claude: the wrapped line of a narrow pane is one input, and one Ctrl+U leaves its first lines', () => {
    const typed = readInputBox('claude', fixture('claude-2.1.310-linux-narrow-typed-wrapped.txt'));
    expect(typed.state).toBe('filled');
    expect(readInputBox('claude', fixture('claude-2.1.310-linux-narrow-after-one-ctrl-u.txt')).state).toBe('filled');
  });
});
