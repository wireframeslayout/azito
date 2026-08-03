import { describe, it, expect } from 'vitest';
import { resolveInitialLanguage } from './detectLanguage';

describe('resolveInitialLanguage', () => {
  it('returns stored value when it is a supported language', () => {
    expect(resolveInitialLanguage('ja', ['en'])).toBe('ja');
    expect(resolveInitialLanguage('en', ['ja'])).toBe('en');
  });

  it('ignores stored value that is not supported', () => {
    expect(resolveInitialLanguage('fr', ['en'])).toBe('en');
    expect(resolveInitialLanguage('fr', ['ja'])).toBe('ja');
  });

  it('detects ja from browser language ja-JP', () => {
    expect(resolveInitialLanguage(null, ['ja-JP'])).toBe('ja');
  });

  it('detects ja from browser language ja', () => {
    expect(resolveInitialLanguage(null, ['ja'])).toBe('ja');
  });

  it('detects ja when it appears among multiple browser languages', () => {
    expect(resolveInitialLanguage(null, ['fr', 'de', 'ja'])).toBe('ja');
  });

  it('falls back to en when no browser language matches', () => {
    expect(resolveInitialLanguage(null, ['fr', 'de'])).toBe('en');
  });

  it('falls back to en when browser languages is empty', () => {
    expect(resolveInitialLanguage(null, [])).toBe('en');
  });

  it('stored value takes priority over browser languages', () => {
    expect(resolveInitialLanguage('en', ['ja', 'ja-JP'])).toBe('en');
    expect(resolveInitialLanguage('ja', ['en-US'])).toBe('ja');
  });
});
