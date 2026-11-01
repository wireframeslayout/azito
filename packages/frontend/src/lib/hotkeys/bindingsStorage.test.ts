import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBindings, loadChordMs, saveBindings, saveChordMs } from './bindingsStorage';
import { formatKeySpec, parseKeySpec } from './keySpec';
const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) }; };
afterEach(() => vi.unstubAllGlobals());
describe('binding storage', () => {
  it('round trips disabled and assigned bindings', () => { vi.stubGlobal('localStorage', storage()); expect(saveBindings({ 'search.open': null, 'maximize.open': parseKeySpec('Ctrl+Shift+M') })).toBe(true); expect(loadBindings()['search.open']).toBeNull(); expect(saveChordMs(500)).toBe(true); expect(loadChordMs()).toBe(500); });
  it('restores defaults on corrupt data', () => { const s = storage(); s.setItem('azito.hotkeyBindings', '{'); vi.stubGlobal('localStorage', s); vi.spyOn(console, 'warn').mockImplementation(() => {}); expect(formatKeySpec(loadBindings()['search.open']!)).toBe('Space Space'); vi.restoreAllMocks(); });
  it('reports inaccessible storage', () => { vi.stubGlobal('localStorage', { setItem: () => { throw Error('denied'); } }); vi.spyOn(console, 'warn').mockImplementation(() => {}); expect(saveChordMs(300)).toBe(false); vi.restoreAllMocks(); });
});
