import { describe, expect, it } from 'vitest';
import { resolveHarnessPrefix } from './harnessPrefix';

describe('resolveHarnessPrefix', () => {
  it('returns an empty string for none', () => {
    expect(resolveHarnessPrefix(undefined)).toBe('');
    expect(resolveHarnessPrefix('')).toBe('');
  });

  it('accepts lowercase letters, digits and hyphens', () => {
    expect(resolveHarnessPrefix('dev')).toBe('dev');
    expect(resolveHarnessPrefix('staging-2')).toBe('staging-2');
  });

  it.each(['../x', 'Dev', 'a b', 'a_b', 'a/b'])('refuses %j, naming the variable', (bad) => {
    expect(() => resolveHarnessPrefix(bad)).toThrow(/AZITO_HARNESS_PREFIX/);
  });
});
