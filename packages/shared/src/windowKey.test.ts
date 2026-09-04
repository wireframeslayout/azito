import { describe, it, expect } from 'vitest';
import { stripPaneSuffix, isSameWindowTarget, windowKey } from './windowKey';

describe('stripPaneSuffix', () => {
  it('removes trailing .N pane suffix', () => {
    expect(stripPaneSuffix('main:0.1')).toBe('main:0');
    expect(stripPaneSuffix('azito:win--abc.0')).toBe('azito:win--abc');
    expect(stripPaneSuffix('session:3.12')).toBe('session:3');
  });

  it('passes through targets without a pane suffix', () => {
    expect(stripPaneSuffix('main:0')).toBe('main:0');
    expect(stripPaneSuffix('azito:win--abc')).toBe('azito:win--abc');
  });

  it('does not strip non-numeric suffixes', () => {
    expect(stripPaneSuffix('session:my.window')).toBe('session:my.window');
  });

  it('is idempotent', () => {
    const once = stripPaneSuffix('main:0.1');
    expect(stripPaneSuffix(once)).toBe(once);
  });
});

describe('isSameWindowTarget', () => {
  it('matches targets that differ only by pane suffix', () => {
    expect(isSameWindowTarget('main:0.1', 'main:0')).toBe(true);
    expect(isSameWindowTarget('main:0', 'main:0.2')).toBe(true);
    expect(isSameWindowTarget('main:0.1', 'main:0.3')).toBe(true);
  });

  it('does not match different windows', () => {
    expect(isSameWindowTarget('main:0', 'main:1')).toBe(false);
    expect(isSameWindowTarget('a:w', 'b:w')).toBe(false);
  });
});

describe('windowKey', () => {
  it('produces serverName::strippedTarget format', () => {
    expect(windowKey('local', 'main:0')).toBe('local::main:0');
    expect(windowKey('local', 'main:0.1')).toBe('local::main:0');
    expect(windowKey('srv01', 'azito:win--abc.0')).toBe('srv01::azito:win--abc');
  });

  it('is idempotent (double strip is harmless)', () => {
    const key1 = windowKey('local', 'main:0.1');
    const key2 = windowKey('local', 'main:0');
    expect(key1).toBe(key2);
  });
});
