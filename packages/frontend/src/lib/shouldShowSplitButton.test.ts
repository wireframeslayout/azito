import { describe, expect, it } from 'vitest';
import { shouldShowSplitButton } from './shouldShowSplitButton';

describe('shouldShowSplitButton', () => {
  it('shows for a tmux window on desktop', () => {
    expect(shouldShowSplitButton({ windowKind: 'tmux', isMobile: false })).toBe(true);
  });

  it('hides for a misao window', () => {
    expect(shouldShowSplitButton({ windowKind: 'misao', isMobile: false })).toBe(false);
  });

  it('hides while the window kind is unknown', () => {
    expect(shouldShowSplitButton({ windowKind: undefined, isMobile: false })).toBe(false);
  });

  it('hides on mobile whatever the kind', () => {
    expect(shouldShowSplitButton({ windowKind: 'tmux', isMobile: true })).toBe(false);
    expect(shouldShowSplitButton({ windowKind: 'misao', isMobile: true })).toBe(false);
  });
});
