import { describe, expect, it } from 'vitest';
import { readRightPanelOpen, writeRightPanelOpen } from './useRightPanelState';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
const broken: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

describe('right panel open state', () => {
  it('starts closed when nothing or an unknown value is saved', () => {
    const storage = memoryStorage();
    expect(readRightPanelOpen(storage)).toBe(false);
    storage.setItem('workspace-right-panel-open', 'yes');
    expect(readRightPanelOpen(storage)).toBe(false);
  });

  it('round-trips the saved value under workspace-right-panel-open', () => {
    const storage = memoryStorage();
    writeRightPanelOpen(storage, true);
    expect(storage.getItem('workspace-right-panel-open')).toBe('true');
    expect(readRightPanelOpen(storage)).toBe(true);
    writeRightPanelOpen(storage, false);
    expect(readRightPanelOpen(storage)).toBe(false);
  });

  it('survives a storage that throws', () => {
    expect(readRightPanelOpen(broken)).toBe(false);
    expect(() => writeRightPanelOpen(broken, true)).not.toThrow();
  });
});
