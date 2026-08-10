import { describe, it, expect, beforeEach } from 'vitest';

// The vitest environment for this package is 'node' (no jsdom), but spFooterHeight.ts writes
// through `document.documentElement.style`. Stub a minimal CSSStyleDeclaration-like object so
// the module's real (non-mocked) logic runs against a working `document` global.
const properties = new Map<string, string>();
(globalThis as { document?: unknown }).document = {
  documentElement: {
    style: {
      setProperty: (prop: string, value: string) => properties.set(prop, value),
      getPropertyValue: (prop: string) => properties.get(prop) ?? '',
      removeProperty: (prop: string) => properties.delete(prop),
    },
  },
};

const { claimFooterHeight, releaseFooterHeight, __resetFooterHeightOwnerForTest } = await import('./spFooterHeight');

function currentVar(): string {
  return properties.get('--sp-footer-h') ?? '';
}

describe('spFooterHeight owner registry', () => {
  beforeEach(() => {
    __resetFooterHeightOwnerForTest();
    properties.delete('--sp-footer-h');
  });

  it('publishes the claimed height', () => {
    claimFooterHeight('a', 44);
    expect(currentVar()).toBe('44px');
  });

  it('later claim wins over an earlier one from a different owner', () => {
    claimFooterHeight('a', 44);
    claimFooterHeight('b', 120);
    expect(currentVar()).toBe('120px');
  });

  it('release from the current owner resets to 0', () => {
    claimFooterHeight('a', 44);
    releaseFooterHeight('a');
    expect(currentVar()).toBe('0px');
  });

  it('release from a non-owner is a no-op and does not clobber the current owner value', () => {
    // Regression for the child-before-parent effect race (Issue #338 T1): a stale owner's
    // release (e.g. TerminalContainer's showQuickKeyBar=false branch) must not wipe out a
    // value claimed afterward by a different owner (e.g. PromptInputBar's measured height).
    claimFooterHeight('prompt-input-bar', 120);
    releaseFooterHeight('quick-key-bar');
    expect(currentVar()).toBe('120px');
  });

  it('re-claiming by the same owner updates the value', () => {
    claimFooterHeight('a', 44);
    claimFooterHeight('a', 60);
    expect(currentVar()).toBe('60px');
  });
});
