import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  classifyScreen,
  classifyTitle,
  splitPromptBox,
  WORKING_SPINNER_TITLE_RE,
  CLAUDE_IDLE_TITLE_RE,
  type AgentKind,
  type PaneAgentState,
} from './agentScreenRules';

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'claude-2.1.263');

const FIXTURE_CASES: Array<{ file: string; expected: PaneAgentState }> = [
  { file: 'working-80x24.txt', expected: 'working' },
  { file: 'working-120x50.txt', expected: 'working' },
  { file: 'blocked-ask-80x24.txt', expected: 'blocked' },
  { file: 'blocked-ask-120x50.txt', expected: 'blocked' },
  { file: 'blocked-perm-80x24.txt', expected: 'blocked' },
  { file: 'blocked-perm-120x50.txt', expected: 'blocked' },
  { file: 'idle-80x24.txt', expected: 'idle' },
  { file: 'idle-120x50.txt', expected: 'idle' },
];

describe('agentScreenRules', () => {
  describe('fixture-based classifyScreen', () => {
    for (const { file, expected } of FIXTURE_CASES) {
      it(`classifies ${file} as ${expected}`, () => {
        const filePath = path.join(FIXTURE_DIR, file);
        expect(fs.existsSync(filePath), `fixture ${file} must exist`).toBe(true);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = stripAnsi(raw)
          .split('\n')
          .filter((l) => !l.startsWith('#'));
        const input = splitPromptBox(lines);
        const result = classifyScreen('claude', input);
        expect(result).toBe(expected);
      });
    }
  });

  describe('splitPromptBox', () => {
    it('splits on rule lines and returns above + promptBox', () => {
      const rows = [
        'some output',
        '  ✻ Thinking… (5s)',
        '──────────────────────────────',
        '  ❯ ',
        '──────────────────────────────',
      ];
      const { above, promptBox } = splitPromptBox(rows);
      expect(above).toEqual(['some output', '  ✻ Thinking… (5s)']);
      expect(promptBox).toEqual(['  ❯ ']);
    });

    it('returns all non-empty lines as above when no rule lines exist', () => {
      const rows = ['line1', '', 'line2', 'line3'];
      const { above, promptBox } = splitPromptBox(rows);
      expect(above).toEqual(['line1', 'line2', 'line3']);
      expect(promptBox).toEqual([]);
    });

    it('limits above to maxAbove lines', () => {
      const rows = Array.from({ length: 20 }, (_, i) => `line${i}`);
      rows.push('──────────────────────────────');
      rows.push('  ❯ ');
      rows.push('──────────────────────────────');
      const { above } = splitPromptBox(rows, 5);
      expect(above).toHaveLength(5);
    });

    it('handles trailing empty lines', () => {
      const rows = ['output', '', '', ''];
      const { above, promptBox } = splitPromptBox(rows);
      expect(above).toEqual(['output']);
      expect(promptBox).toEqual([]);
    });
  });

  describe('classifyTitle', () => {
    describe('claude', () => {
      it.each(['⠐', '⠙', '◐', '◑', '◒', '◓', '✻', '✶', '✽', '✢', '∗'])(
        'classifies spinner glyph %s as working',
        (glyph) => {
          expect(classifyTitle('claude', `${glyph} task`)).toBe('working');
        },
      );

      it('classifies ✳ as idle', () => {
        expect(classifyTitle('claude', '✳ task')).toBe('idle');
      });

      it('returns unknown for unrecognized title', () => {
        expect(classifyTitle('claude', 'some title')).toBe('unknown');
      });

      it('returns unknown for empty title', () => {
        expect(classifyTitle('claude', '')).toBe('unknown');
      });
    });

    describe('codex', () => {
      it('classifies Action Required as blocked', () => {
        expect(classifyTitle('codex', 'Action Required')).toBe('blocked');
      });

      it('classifies braille spinner as working', () => {
        expect(classifyTitle('codex', '⠙ codex')).toBe('working');
      });

      it('classifies non-empty title as idle', () => {
        expect(classifyTitle('codex', 'codex')).toBe('idle');
      });

      it('returns unknown for empty title', () => {
        expect(classifyTitle('codex', '')).toBe('unknown');
      });
    });
  });

  describe('classifyScreen', () => {
    it('returns null for transcript viewer (skip)', () => {
      const input = { above: ['Showing detailed transcript for session abc'], promptBox: [] };
      expect(classifyScreen('claude', input)).toBeNull();
    });

    it('returns blocked for enter to select + esc to cancel', () => {
      const input = { above: ['enter to select · esc to cancel'], promptBox: ['  ❯ '] };
      expect(classifyScreen('claude', input)).toBe('blocked');
    });

    it('returns blocked for do you want to proceed', () => {
      const input = { above: ['Do you want to proceed?'], promptBox: [] };
      expect(classifyScreen('claude', input)).toBe('blocked');
    });

    it('returns working for esc to interrupt', () => {
      const input = { above: ['  ⏵⏵ Reading file… esc to interrupt'], promptBox: [] };
      expect(classifyScreen('claude', input)).toBe('working');
    });

    it('returns working for spinner line', () => {
      const input = { above: ['  ✻ Thinking… (12s · ↓ 1.2k tokens)'], promptBox: [] };
      expect(classifyScreen('claude', input)).toBe('working');
    });

    it('returns idle for prompt box with ❯', () => {
      const input = { above: ['some output'], promptBox: ['  ❯ '] };
      expect(classifyScreen('claude', input)).toBe('idle');
    });

    it('returns unknown when nothing matches', () => {
      const input = { above: ['random output'], promptBox: [] };
      expect(classifyScreen('claude', input)).toBe('unknown');
    });

    it('blocked wins over idle (higher priority)', () => {
      const input = {
        above: ['enter to select · esc to cancel'],
        promptBox: ['  ❯ '],
      };
      expect(classifyScreen('claude', input)).toBe('blocked');
    });

    describe('codex', () => {
      it('returns blocked for press enter to confirm', () => {
        const input = { above: ['press Enter to confirm or Esc to cancel'], promptBox: [] };
        expect(classifyScreen('codex', input)).toBe('blocked');
      });

      it('returns blocked for allow command?', () => {
        const input = { above: ['Allow command?'], promptBox: [] };
        expect(classifyScreen('codex', input)).toBe('blocked');
      });

      it('returns working for esc to interrupt', () => {
        const input = { above: ['Working… esc to interrupt'], promptBox: [] };
        expect(classifyScreen('codex', input)).toBe('working');
      });

      it('returns unknown when nothing matches', () => {
        const input = { above: ['some output'], promptBox: [] };
        expect(classifyScreen('codex', input)).toBe('unknown');
      });
    });
  });

  describe('exported regex constants', () => {
    it('WORKING_SPINNER_TITLE_RE matches braille and half-circle glyphs', () => {
      expect(WORKING_SPINNER_TITLE_RE.test('⠐ task')).toBe(true);
      expect(WORKING_SPINNER_TITLE_RE.test('◐ task')).toBe(true);
      expect(WORKING_SPINNER_TITLE_RE.test('✻ task')).toBe(true);
    });

    it('CLAUDE_IDLE_TITLE_RE matches ✳', () => {
      expect(CLAUDE_IDLE_TITLE_RE.test('✳ task')).toBe(true);
      expect(CLAUDE_IDLE_TITLE_RE.test('✻ task')).toBe(false);
    });
  });
});
