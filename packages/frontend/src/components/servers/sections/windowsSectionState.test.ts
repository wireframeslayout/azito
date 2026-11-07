import { describe, expect, it } from 'vitest';
import { windowsEmptyView } from './windowsSectionState';

describe('windows empty view', () => {
  it('does not show the empty state or creation action when the listing is unavailable', () => {
    expect(windowsEmptyView('error', 0)).toBe('unavailable');
    expect(windowsEmptyView('partial', 0)).toBe('unavailable');
  });
  it('shows loading, empty, and existing sessions separately', () => {
    expect(windowsEmptyView('loading', 0)).toBe('loading');
    expect(windowsEmptyView('ready', 0)).toBe('empty');
    expect(windowsEmptyView('partial', 1)).toBe('content');
  });
});
