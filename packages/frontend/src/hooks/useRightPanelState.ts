import { useState } from 'react';

const KEY = 'workspace-right-panel-open';
export function useRightPanelState(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
  });
  function update(value: boolean): void {
    setOpen(value);
    try { localStorage.setItem(KEY, String(value)); } catch { /* Storage may be unavailable. */ }
  }
  return [open, update];
}
