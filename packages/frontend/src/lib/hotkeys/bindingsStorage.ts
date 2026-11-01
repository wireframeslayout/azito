import { z } from 'zod';
import { formatKeySpec, parseKeySpec, type KeySpec } from './keySpec';

export type HotkeyAction = 'search.open' | 'maximize.open';
export type Bindings = Record<HotkeyAction, KeySpec | null>;
const BINDINGS_KEY = 'azito-hotkeys';
const CHORD_KEY = 'azito-hotkeys-chord-ms';
const defaults = (): Bindings => ({ 'search.open': parseKeySpec('Space Space'), 'maximize.open': parseKeySpec('Ctrl+Shift+M') });
const storedSpec = z.object({ text: z.string(), windowMs: z.number().positive().optional() }).strict().nullable();
const schema = z.object({ 'search.open': storedSpec.optional(), 'maximize.open': storedSpec.optional() });
function decodeSpec(value: z.infer<typeof storedSpec>): KeySpec | null {
  if (value === null) return null;
  return { ...parseKeySpec(value.text), ...(value.windowMs === undefined ? {} : { windowMs: value.windowMs }) };
}

/** Returns the other action already assigned to `spec`, or null when `spec` is free for `action`. */
export function findConflictingAction(bindings: Bindings, action: HotkeyAction, spec: KeySpec): HotkeyAction | null {
  const text = formatKeySpec(spec);
  const entries = Object.entries(bindings) as [HotkeyAction, KeySpec | null][];
  return entries.find(([other, assigned]) => other !== action && assigned !== null && formatKeySpec(assigned) === text)?.[0] ?? null;
}
const hasDuplicateBindings = (bindings: Bindings): boolean =>
  (Object.entries(bindings) as [HotkeyAction, KeySpec | null][]).some(([action, spec]) => spec !== null && findConflictingAction(bindings, action, spec) !== null);

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    if (raw === null) return defaults();
    const value = schema.parse(JSON.parse(raw));
    const result = defaults();
    for (const action of Object.keys(result) as HotkeyAction[]) {
      const saved = value[action];
      if (saved !== undefined) result[action] = decodeSpec(saved);
    }
    if (hasDuplicateBindings(result)) throw new Error('Duplicate bindings');
    return result;
  } catch (error) { console.warn('Invalid or unavailable hotkey bindings', error); return defaults(); }
}
export function saveBindings(bindings: Bindings): boolean {
  try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, value && { text: formatKeySpec(value), ...(value.windowMs === undefined ? {} : { windowMs: value.windowMs }) }])))); return true; }
  catch (error) { console.warn('Could not save hotkey bindings', error); return false; }
}
export function loadChordMs(): number {
  try { const raw = localStorage.getItem(CHORD_KEY); if (raw === null) return 300; const value = z.union([z.literal(200), z.literal(300), z.literal(500)]).parse(JSON.parse(raw)); return value; }
  catch (error) { console.warn('Invalid or unavailable hotkey interval', error); return 300; }
}
export function saveChordMs(ms: number): boolean {
  try { z.union([z.literal(200), z.literal(300), z.literal(500)]).parse(ms); localStorage.setItem(CHORD_KEY, JSON.stringify(ms)); return true; }
  catch (error) { console.warn('Could not save hotkey interval', error); return false; }
}
