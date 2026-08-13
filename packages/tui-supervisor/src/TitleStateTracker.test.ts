import { describe, expect, it } from 'vitest';
import { TitleStateTracker } from './TitleStateTracker';

const OSC2 = (title: string, terminator: string = '\x07') => `\x1b]2;${title}${terminator}`;
const OSC0 = (title: string, terminator: string = '\x07') => `\x1b]0;${title}${terminator}`;
const ST = '\x1b\\';

describe('TitleStateTracker', () => {
  it('is unknown before any title has been observed', () => {
    const t = new TitleStateTracker();
    expect(t.getState()).toBe('unknown');
    t.push('plain output with no OSC sequences at all');
    expect(t.getState()).toBe('unknown');
  });

  it('classifies a braille-spinner title as working (OSC 2, BEL-terminated)', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('⠐ タスク要約'));
    expect(t.getState()).toBe('working');
  });

  it('classifies a ✳-prefixed title as idle', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('✳ タスク要約'));
    expect(t.getState()).toBe('idle');
  });

  it('classifies a half-circle-spinner title as working (real-world observed: current Claude Code)', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('◐ libghosttyのwasm版導入検討'));
    expect(t.getState()).toBe('working');
  });

  it('classifies a real-world observed idle title as idle (current Claude Code)', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('✳ テスト投稿の実装'));
    expect(t.getState()).toBe('idle');
  });

  it('classifies every half-circle spinner frame as working', () => {
    for (const glyph of ['◐', '◑', '◒', '◓']) {
      const t = new TitleStateTracker();
      t.push(OSC2(`${glyph} spinning`));
      expect(t.getState()).toBe('working');
    }
  });

  it('classifies legacy asterisk-family spinner glyphs as working', () => {
    for (const glyph of ['✻', '✶', '✽', '✢', '∗']) {
      const t = new TitleStateTracker();
      t.push(OSC2(`${glyph} spinning`));
      expect(t.getState()).toBe('working');
    }
  });

  it('still classifies a braille-spinner title as working (codex, unchanged)', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('⠴ codex working'));
    expect(t.getState()).toBe('working');
  });

  it('classifies an "Action Required" title as blocked, beating the spinner rule', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('⠐ Action Required: approve command'));
    expect(t.getState()).toBe('blocked');
  });

  it('classifies any other non-empty title as idle (codex convention)', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('codex'));
    expect(t.getState()).toBe('idle');
  });

  it('recognizes OSC 0 sequences too', () => {
    const t = new TitleStateTracker();
    t.push(OSC0('⠙ working away'));
    expect(t.getState()).toBe('working');
  });

  it('recognizes an ST-terminated (ESC \\) sequence', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('⠐ working', ST));
    expect(t.getState()).toBe('working');
  });

  it('uses the last title when a chunk contains several', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('⠐ working') + 'some output' + OSC2('✳ done'));
    expect(t.getState()).toBe('idle');
  });

  it('keeps the previous state when a later title is empty (transient blank during redraw)', () => {
    const t = new TitleStateTracker();
    t.push(OSC2('⠐ working'));
    t.push(OSC2(''));
    expect(t.getState()).toBe('working');
  });

  it('reassembles a sequence split across chunk boundaries (mid-title split)', () => {
    const t = new TitleStateTracker();
    t.push('output before \x1b]2;⠐ タスク');
    expect(t.getState()).toBe('unknown'); // not terminated yet
    t.push('要約\x07 output after');
    expect(t.getState()).toBe('working');
  });

  it('reassembles a sequence split right after the ESC', () => {
    const t = new TitleStateTracker();
    t.push('output\x1b');
    t.push(']2;✳ idle now\x07');
    expect(t.getState()).toBe('idle');
  });

  it('reassembles a sequence split inside the OSC prefix (between ] and the code)', () => {
    const t = new TitleStateTracker();
    t.push('output\x1b]');
    t.push('2;⠐ still working\x07');
    expect(t.getState()).toBe('working');
  });

  it('reassembles an ST terminator split between its ESC and backslash', () => {
    const t = new TitleStateTracker();
    t.push(`\x1b]2;⠐ working\x1b`);
    t.push('\\');
    expect(t.getState()).toBe('working');
  });

  it('does not let an unterminated sequence grow the carry-over buffer without bound', () => {
    const t = new TitleStateTracker();
    t.push('\x1b]2;' + 'x'.repeat(3_000));
    // Still under the cap: carried over; a terminator later completes it.
    t.push('y'.repeat(3_000)); // now past the 4096 cap → dropped
    t.push('\x07'); // stray terminator with no carried prefix — no title
    expect(t.getState()).toBe('unknown');
    // The parser still works normally afterward.
    t.push(OSC2('⠐ recovered'));
    expect(t.getState()).toBe('working');
  });

  it('ignores non-title OSC and CSI sequences', () => {
    const t = new TitleStateTracker();
    t.push('\x1b[2J\x1b[H\x1b]133;A\x07plain');
    expect(t.getState()).toBe('unknown');
  });
});
