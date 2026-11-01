import { useState } from 'react';

const KEY = 'workspace-right-panel-open';

type PanelStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The saved open state; closed when nothing (or anything other than `true`) is saved or storage cannot be read. */
export function readRightPanelOpen(storage: PanelStorage): boolean {
  try { return storage.getItem(KEY) === 'true'; } catch { return false; }
}

/** Saves the open state; a storage that refuses (quota, private mode) only loses persistence. */
export function writeRightPanelOpen(storage: PanelStorage, open: boolean): void {
  try { storage.setItem(KEY, String(open)); } catch { /* Persistence is best-effort; the in-memory state still applies. */ }
}

export function useRightPanelState(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readRightPanelOpen(localStorage));
  function update(value: boolean): void {
    setOpen(value);
    writeRightPanelOpen(localStorage, value);
  }
  return [open, update];
}
