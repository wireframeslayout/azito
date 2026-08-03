import { describe, it, expect } from 'vitest';
import { generateWindowName, stripWindowId, extractWindowId } from './windowNameUtils';

describe('windowNameUtils', () => {
  describe('generateWindowName', () => {
    it('generates a name with --<4-char> suffix', () => {
      const name = generateWindowName('win');
      expect(name).toMatch(/^win--[a-z0-9]{4}$/);
    });

    it('uses "win" as default base name', () => {
      const name = generateWindowName();
      expect(name).toMatch(/^win--[a-z0-9]{4}$/);
    });

    it('strips existing suffix before adding new one', () => {
      const name = generateWindowName('task-1--abc1');
      expect(name).toMatch(/^task-1--[a-z0-9]{4}$/);
      expect(name).not.toContain('abc1--');
    });

    it('preserves base name with hyphens', () => {
      const name = generateWindowName('my-window');
      expect(name).toMatch(/^my-window--[a-z0-9]{4}$/);
    });

    it('generates unique names on successive calls', () => {
      const names = new Set(Array.from({ length: 20 }, () => generateWindowName('win')));
      expect(names.size).toBeGreaterThan(1);
    });
  });

  describe('stripWindowId', () => {
    it('removes --<4-char> suffix', () => {
      expect(stripWindowId('win--abc1')).toBe('win');
    });

    it('returns unchanged string without suffix', () => {
      expect(stripWindowId('bash')).toBe('bash');
    });

    it('returns unchanged string with wrong suffix length', () => {
      expect(stripWindowId('win--ab')).toBe('win--ab');
      expect(stripWindowId('win--abcde')).toBe('win--abcde');
    });

    it('handles task-style names', () => {
      expect(stripWindowId('task-42--x9z1')).toBe('task-42');
    });

    it('does not strip from middle of string', () => {
      expect(stripWindowId('win--abc1.1')).toBe('win--abc1.1');
    });

    it('returns empty string for empty input', () => {
      expect(stripWindowId('')).toBe('');
    });
  });

  describe('extractWindowId', () => {
    it('extracts 4-char id from suffix', () => {
      expect(extractWindowId('win--abc1')).toBe('abc1');
    });

    it('returns null for names without suffix', () => {
      expect(extractWindowId('bash')).toBeNull();
    });

    it('returns null for wrong suffix format', () => {
      expect(extractWindowId('win--ab')).toBeNull();
      expect(extractWindowId('win--ABCD')).toBeNull();
    });

    it('returns null when suffix is not at end', () => {
      expect(extractWindowId('win--abc1.1')).toBeNull();
    });
  });
});
