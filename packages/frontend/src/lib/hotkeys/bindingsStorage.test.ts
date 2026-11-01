import { afterEach, describe, expect, it, vi } from 'vitest';
import { findConflictingAction, loadBindings, loadChordMs, saveBindings, saveChordMs } from './bindingsStorage';
import { formatKeySpec, parseKeySpec } from './keySpec';
const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) }; };
afterEach(() => vi.unstubAllGlobals());
describe('binding storage', () => {
  it('round trips disabled and assigned bindings', () => { vi.stubGlobal('localStorage', storage()); expect(saveBindings({ 'search.open': null, 'maximize.open': parseKeySpec('Ctrl+Shift+M') })).toBe(true); expect(loadBindings()['search.open']).toBeNull(); expect(saveChordMs(500)).toBe(true); expect(loadChordMs()).toBe(500); expect(localStorage.getItem('azito-hotkeys')).not.toBeNull(); expect(localStorage.getItem('azito-hotkeys-chord-ms')).toBe('500'); });
  it('restores defaults on corrupt data', () => { const s = storage(); s.setItem('azito-hotkeys', '{'); vi.stubGlobal('localStorage', s); vi.spyOn(console, 'warn').mockImplementation(() => {}); expect(formatKeySpec(loadBindings()['search.open']!)).toBe('Space Space'); vi.restoreAllMocks(); });
  it('reports inaccessible storage', () => { vi.stubGlobal('localStorage', { setItem: () => { throw Error('denied'); } }); vi.spyOn(console, 'warn').mockImplementation(() => {}); expect(saveChordMs(300)).toBe(false); vi.restoreAllMocks(); });
});
describe('findConflictingAction', () => {
  const bindings = { 'search.open': parseKeySpec('Space Space'), 'maximize.open': parseKeySpec('Ctrl+Shift+M') };
  it('reports every other action holding the same keys', () => {
    expect(findConflictingAction(bindings, 'maximize.open', parseKeySpec('Space Space'))).toBe('search.open');
    expect(findConflictingAction(bindings, 'search.open', parseKeySpec('Ctrl+Shift+M'))).toBe('maximize.open');
  });
  it('ignores the action itself, disabled actions and free keys', () => {
    expect(findConflictingAction(bindings, 'search.open', parseKeySpec('Space Space'))).toBeNull();
    expect(findConflictingAction({ ...bindings, 'search.open': null }, 'maximize.open', parseKeySpec('Space Space'))).toBeNull();
    expect(findConflictingAction(bindings, 'search.open', parseKeySpec('Ctrl+K'))).toBeNull();
  });
  it('rejects stored bindings that share keys', () => {
    const s = storage(); s.setItem('azito-hotkeys', JSON.stringify({ 'search.open': { text: 'Ctrl+K' }, 'maximize.open': { text: 'Ctrl+K' } })); vi.stubGlobal('localStorage', s);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(formatKeySpec(loadBindings()['maximize.open']!)).toBe('Ctrl+Shift+M'); vi.restoreAllMocks();
  });
});
