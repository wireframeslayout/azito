import { describe, it, expect } from 'vitest';
import { stripPaneSuffix, isSameWindowTarget } from './tmuxTarget';

describe('stripPaneSuffix', () => {
  it('removes a trailing pane index', () => {
    expect(stripPaneSuffix('session:window.1')).toBe('session:window');
  });

  it('removes a multi-digit trailing pane index', () => {
    expect(stripPaneSuffix('session:window.12')).toBe('session:window');
  });

  it('leaves a target without a pane suffix unchanged', () => {
    expect(stripPaneSuffix('session:window')).toBe('session:window');
  });

  it('does not strip a dot that is part of the window name itself', () => {
    expect(stripPaneSuffix('session:my.window')).toBe('session:my.window');
  });

  it('only strips the final numeric suffix, not an earlier one', () => {
    expect(stripPaneSuffix('session:my.1window.2')).toBe('session:my.1window');
  });
});

describe('isSameWindowTarget', () => {
  it('treats a bare target and its pane-suffixed form as the same window', () => {
    expect(isSameWindowTarget('session:window', 'session:window.1')).toBe(true);
  });

  it('treats two different pane suffixes of the same window as the same window', () => {
    expect(isSameWindowTarget('session:window.1', 'session:window.2')).toBe(true);
  });

  it('treats different windows as different', () => {
    expect(isSameWindowTarget('session:window1', 'session:window2')).toBe(false);
  });
});
