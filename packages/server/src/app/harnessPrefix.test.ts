import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { isValidHarnessPrefix, resolveHarnessPrefix } from './harnessPrefix';

const SETUP_PATTERN_FILE = path.resolve(__dirname, '..', '..', '..', '..', 'harness', 'lib', 'claudeSettings.mjs');
const ACCEPTED = ['dev', 'prod.eu', 'Dev', 'dev_1', 'staging-2', '1a'];
const REFUSED = ['../x', 'a/b', '.x', 'a..b', 'a b', '-x', '_x', 'a\\b'];

describe('resolveHarnessPrefix', () => {
  it('returns an empty string for none', () => {
    expect(resolveHarnessPrefix(undefined)).toBe('');
    expect(resolveHarnessPrefix('')).toBe('');
  });

  it.each(ACCEPTED)('accepts %j, the prefixes setup.sh / setup.mjs install', (ok) => {
    expect(resolveHarnessPrefix(ok)).toBe(ok);
  });

  it.each(REFUSED)('refuses %j, naming the variable', (bad) => {
    expect(() => resolveHarnessPrefix(bad)).toThrow(/AZITO_HARNESS_PREFIX/);
  });

  it('is the same rule as setup.mjs (PREFIX_PATTERN and its ".." check)', async () => {
    const { PREFIX_PATTERN } = (await import(pathToFileURL(SETUP_PATTERN_FILE).href)) as { PREFIX_PATTERN: RegExp };
    for (const value of [...ACCEPTED, ...REFUSED]) {
      expect(isValidHarnessPrefix(value), value).toBe(PREFIX_PATTERN.test(value) && !value.includes('..'));
    }
  });
});
