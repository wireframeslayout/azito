export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm');
}
