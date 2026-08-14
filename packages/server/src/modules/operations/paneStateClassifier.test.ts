import { describe, it, expect } from 'vitest';
import { classifyPaneState } from './paneStateClassifier';

describe('classifyPaneState', () => {
  describe('claude', () => {
    it('classifies a leading braille spinner title as working', () => {
      expect(classifyPaneState({ paneTitle: '⠐ タスク要約', agentType: 'claude' })).toBe('working');
    });

    it('classifies a leading ✳ title as idle', () => {
      expect(classifyPaneState({ paneTitle: '✳ タスク要約', agentType: 'claude' })).toBe('idle');
    });

    it('classifies "esc to interrupt" in the screen tail as working when the title is inconclusive', () => {
      expect(classifyPaneState({
        paneTitle: 'claude',
        screenTail: '  Doing the thing…\n\n  esc to interrupt',
        agentType: 'claude',
      })).toBe('working');
    });

    it('classifies a permission prompt ("enter to select" + "esc to cancel") as blocked', () => {
      expect(classifyPaneState({
        paneTitle: 'claude',
        screenTail: 'Allow this action?\n  enter to select · esc to cancel',
        agentType: 'claude',
      })).toBe('blocked');
    });

    it('classifies "Do you want to proceed?" as blocked', () => {
      expect(classifyPaneState({
        paneTitle: 'claude',
        screenTail: 'Do you want to proceed?',
        agentType: 'claude',
      })).toBe('blocked');
    });

    it('classifies a prompt-box line (❯) as idle when no working/blocked screen rule matches', () => {
      expect(classifyPaneState({
        paneTitle: 'claude',
        screenTail: '  ❯ ',
        agentType: 'claude',
      })).toBe('idle');
    });

    it('returns unknown when neither the title nor the screen tail matches any rule', () => {
      expect(classifyPaneState({ paneTitle: 'claude', screenTail: 'some unrelated output', agentType: 'claude' })).toBe('unknown');
    });

    it('returns unknown when only the title is available and it matches no rule (screen tail not yet fetched)', () => {
      expect(classifyPaneState({ paneTitle: 'claude', agentType: 'claude' })).toBe('unknown');
    });

    it('treats a null title as empty rather than throwing', () => {
      expect(classifyPaneState({ paneTitle: null, agentType: 'claude' })).toBe('unknown');
    });

    it('classifies blocked screen over a working title (spinner + permission prompt)', () => {
      expect(classifyPaneState({
        paneTitle: '⠹ 作業中',
        screenTail: 'Do you want to proceed?',
        agentType: 'claude',
      })).toBe('blocked');
    });

    it('classifies working when title is spinner and screen has no blocked marker', () => {
      expect(classifyPaneState({
        paneTitle: '⠹ 作業中',
        screenTail: 'some normal output without blocked markers',
        agentType: 'claude',
      })).toBe('working');
    });

    it('classifies a real-world observed half-circle spinner title as working', () => {
      expect(classifyPaneState({ paneTitle: '◐ libghosttyのwasm版導入検討', agentType: 'claude' })).toBe('working');
    });

    it('classifies a real-world observed idle title as idle', () => {
      expect(classifyPaneState({ paneTitle: '✳ テスト投稿の実装', agentType: 'claude' })).toBe('idle');
    });

    it.each(['◐', '◑', '◒', '◓'])('classifies half-circle spinner glyph %s as working', (glyph) => {
      expect(classifyPaneState({ paneTitle: `${glyph} 作業中`, agentType: 'claude' })).toBe('working');
    });

    it.each(['✻', '✶', '✽', '✢', '∗'])('classifies legacy asterisk-family spinner glyph %s as working', (glyph) => {
      expect(classifyPaneState({ paneTitle: `${glyph} 作業中`, agentType: 'claude' })).toBe('working');
    });
  });

  describe('codex', () => {
    it('classifies an "Action Required" title as blocked (highest priority)', () => {
      expect(classifyPaneState({ paneTitle: 'Action Required', agentType: 'codex' })).toBe('blocked');
    });

    it('classifies a leading braille spinner title as working', () => {
      expect(classifyPaneState({ paneTitle: '⠙ codex', agentType: 'codex' })).toBe('working');
    });

    it('classifies "press enter to confirm or esc to cancel" in the screen tail as blocked', () => {
      expect(classifyPaneState({
        paneTitle: 'codex',
        screenTail: 'press Enter to confirm or Esc to cancel',
        agentType: 'codex',
      })).toBe('blocked');
    });

    it('classifies "allow command?" as blocked', () => {
      expect(classifyPaneState({ paneTitle: 'codex', screenTail: 'Allow command?', agentType: 'codex' })).toBe('blocked');
    });

    it('classifies "enter to submit" as blocked', () => {
      expect(classifyPaneState({ paneTitle: 'codex', screenTail: 'enter to submit', agentType: 'codex' })).toBe('blocked');
    });

    it('classifies a "[y/n]" screen prompt as blocked (weak signal)', () => {
      expect(classifyPaneState({ paneTitle: 'codex', screenTail: 'Proceed? [y/n]', agentType: 'codex' })).toBe('blocked');
    });

    it('classifies "do you want to ... yes" as blocked (weak signal)', () => {
      expect(classifyPaneState({
        paneTitle: 'codex',
        screenTail: 'do you want to continue? yes/no',
        agentType: 'codex',
      })).toBe('blocked');
    });

    it('classifies a non-empty title with no other rule match as idle', () => {
      expect(classifyPaneState({ paneTitle: 'codex', agentType: 'codex' })).toBe('idle');
    });

    it('returns unknown when the title is empty and the screen tail matches no rule', () => {
      expect(classifyPaneState({ paneTitle: '', screenTail: 'unrelated output', agentType: 'codex' })).toBe('unknown');
    });

    it('returns unknown when the title is null and there is no screen tail yet', () => {
      expect(classifyPaneState({ paneTitle: null, agentType: 'codex' })).toBe('unknown');
    });
  });

  describe('generic / unsupported agentType', () => {
    it('always returns unknown for "generic", regardless of title/screen content', () => {
      expect(classifyPaneState({
        paneTitle: '⠐ spinner-looking title',
        screenTail: 'esc to interrupt',
        agentType: 'generic',
      })).toBe('unknown');
    });

    it('returns unknown for an arbitrary unrecognized agentType', () => {
      expect(classifyPaneState({ paneTitle: '✳ idle', agentType: 'some-future-agent' })).toBe('unknown');
    });
  });
});
