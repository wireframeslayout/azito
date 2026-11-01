export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"]), .xterm');
}
