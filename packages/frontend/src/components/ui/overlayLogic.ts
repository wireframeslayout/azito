const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getAttribute('tabindex') !== '-1' && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden',
  );
}

export function cycleFocus(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const elements = getFocusableElements(container);
  if (elements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}
