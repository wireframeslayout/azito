import { describe, it, expect } from 'vitest';
import { stripTerminalArtifacts } from './stripTerminalArtifacts';

describe('stripTerminalArtifacts', () => {
  it('preserves hyphens in file names and diff lines', () => {
    expect(stripTerminalArtifacts('cms-v2')).toBe('cms-v2');
    expect(stripTerminalArtifacts('-  const removedLine = 1;')).toBe('-  const removedLine = 1;');
    expect(stripTerminalArtifacts('--- a/src/index.ts')).toBe('--- a/src/index.ts');
  });

  it('strips ANSI CSI sequences', () => {
    expect(stripTerminalArtifacts('\x1b[31mcms-v2\x1b[0m')).toBe('cms-v2');
  });

  it('strips OSC sequences', () => {
    expect(stripTerminalArtifacts('\x1b]0;title\x07cms-v2')).toBe('cms-v2');
  });

  it('strips STX markers and control chars but keeps newlines and tabs', () => {
    expect(stripTerminalArtifacts('\x02a\x00b\tc\nd')).toBe('ab\tc\nd');
  });

  it('strips Nerd Font Private Use Area icons (U+E000-U+F8FF)', () => {
    expect(stripTerminalArtifacts('\uE0A0 main')).toBe(' main');
    expect(stripTerminalArtifacts('\uF07B cms-v2')).toBe(' cms-v2');
  });

  it('strips emoji icons', () => {
    expect(stripTerminalArtifacts('\u{1F4C1} docs')).toBe(' docs');
  });
});
