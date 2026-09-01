import { describe, it, expect } from 'vitest';
import { shouldCloseOnKey } from './modalEscape';

/**
 * Escape means two things once an autocomplete dropdown sits inside a modal:
 * "dismiss the dropdown" and "dismiss the modal". Only one of them may act on
 * a given keypress.
 *
 * Before the environment/repository forms moved into modals, nothing enclosed
 * DirectoryInput / RepositoryCandidateInput, so their Escape branches could
 * close their own dropdown without consuming the event. Wrapping them in a
 * Modal turned that into a real defect: dismissing the candidate list also
 * closed the modal, discarding a whole multi-step wizard's input. The fix is
 * a contract between the two halves — the dropdown marks the event handled,
 * and the modal honours that mark. These tests pin the modal's half; the
 * dropdowns' half is the `e.preventDefault()` in their Escape branches.
 */
describe('shouldCloseOnKey', () => {
  it('closes on Escape when nothing else handled the keypress', () => {
    expect(shouldCloseOnKey({ key: 'Escape', defaultPrevented: false })).toBe(true);
  });

  it('leaves Escape alone once an open dropdown has consumed it', () => {
    // What DirectoryInput / RepositoryCandidateInput produce when their
    // dropdown is open: handled, so the modal must stay put.
    expect(shouldCloseOnKey({ key: 'Escape', defaultPrevented: true })).toBe(false);
  });

  it('still closes on the NEXT Escape, once the dropdown is closed and no longer consumes it', () => {
    // Second keypress: the dropdown's `!open` guard returns early, so nothing
    // calls preventDefault and the modal gets its turn. This is the half of
    // the contract that keeps Escape from becoming a dead key inside a modal.
    expect(shouldCloseOnKey({ key: 'Escape', defaultPrevented: false })).toBe(true);
  });

  it('ignores keys other than Escape', () => {
    expect(shouldCloseOnKey({ key: 'Enter', defaultPrevented: false })).toBe(false);
    expect(shouldCloseOnKey({ key: 'Tab', defaultPrevented: false })).toBe(false);
  });
});
