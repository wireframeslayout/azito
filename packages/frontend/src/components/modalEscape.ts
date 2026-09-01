/**
 * Whether an Escape keypress should close the modal.
 *
 * A nested control that already handled Escape — an open autocomplete
 * dropdown dismissing itself — marks the event `defaultPrevented`, and the
 * modal must then leave it alone: the dropdown is nearer the user's
 * attention, and closing the modal too would discard the form behind it.
 * See the Escape branches in DirectoryInput / RepositoryCandidateInput.
 *
 * Kept in its own module (not in Modal.tsx) because importing that component
 * pulls in the i18n bundle, which touches `document` at import time — the
 * test environment is `node`. Same precedent as the other `*Logic.ts` /
 * pure-module splits in this directory.
 */
export function shouldCloseOnKey(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>): boolean {
  return e.key === 'Escape' && !e.defaultPrevented;
}
