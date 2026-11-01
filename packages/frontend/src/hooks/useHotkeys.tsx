import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createChordMatcher, type ChordMatcher } from '../lib/hotkeys/chordMatcher';
import { isEditableTarget } from '../lib/hotkeys/editable';
import type { KeySpec } from '../lib/hotkeys/keySpec';
import { findConflictingAction, loadBindings, loadChordMs, saveBindings, saveChordMs, type Bindings, type HotkeyAction } from '../lib/hotkeys/bindingsStorage';

export type { HotkeyAction } from '../lib/hotkeys/bindingsStorage';
export interface HotkeyRegistration {
  action: HotkeyAction | `local:${string}`;
  spec?: KeySpec;
  scope: 'global' | 'overlay';
  overlayId?: symbol;
  when?: 'always' | 'not-editable';
  handler: (e: KeyboardEvent) => void;
}
type Registration = { current: HotkeyRegistration };
type StackEntry = { id: symbol; element: HTMLElement };
const isInert = (element: HTMLElement): boolean => {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) if (node.inert) return true;
  return false;
};
interface HotkeysContextValue {
  bindings: Bindings;
  chordMs: number;
  setBinding: (action: HotkeyAction, spec: KeySpec | null) => 'ok' | 'conflict' | 'storage-error';
  setChordMs: (ms: number) => 'ok' | 'storage-error';
  register: (id: symbol, reg: Registration) => () => void;
  addOverlay: (id: symbol, element: HTMLElement, returnFocusTo: HTMLElement | null) => () => void;
  stack: StackEntry[];
  dispatchFromTerminal: (e: KeyboardEvent) => boolean;
}
type StableContextValue = Pick<HotkeysContextValue, 'register' | 'addOverlay' | 'dispatchFromTerminal'>;
type BindingsContextValue = Pick<HotkeysContextValue, 'bindings' | 'chordMs' | 'setBinding' | 'setChordMs'>;
const StableContext = createContext<StableContextValue | null>(null);
const BindingsContext = createContext<BindingsContextValue | null>(null);
const StackContext = createContext<StackEntry[]>([]);
function useStableContext(): StableContextValue {
  const value = useContext(StableContext);
  if (!value) throw new Error('HotkeyProvider is required');
  return value;
}

export function HotkeyProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState(loadBindings);
  const [chordMs, updateChordMs] = useState(loadChordMs);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const registrations = useRef(new Map<symbol, Registration>());
  const matchers = useRef(new Map<symbol, { spec: string; matcher: ChordMatcher }>());
  const handled = useRef(new WeakMap<KeyboardEvent, boolean>());
  const pendingFocus = useRef<HTMLElement[]>([]);
  const state = useRef({ bindings, chordMs, stack });
  state.current = { bindings, chordMs, stack };
  const register = (id: symbol, reg: Registration) => {
    registrations.current.set(id, reg);
    return () => { registrations.current.delete(id); matchers.current.delete(id); };
  };
  const addOverlay = (id: symbol, element: HTMLElement, returnFocusTo: HTMLElement | null) => {
    setStack(current => [...current.filter(entry => entry.id !== id), { id, element }]);
    return () => {
      if (returnFocusTo) pendingFocus.current.push(returnFocusTo);
      setStack(current => current.filter(entry => entry.id !== id));
    };
  };
  const dispatch = (e: KeyboardEvent, terminal: boolean): boolean => {
    if (handled.current.has(e)) return handled.current.get(e)!;
    if (e.type !== 'keydown' || e.repeat || e.isComposing || e.key === 'Process') return false;
    const { bindings: currentBindings, chordMs: interval, stack: currentStack } = state.current;
    const top = currentStack.at(-1);
    for (const [id, ref] of [...registrations.current].reverse()) {
      const reg = ref.current;
      if (top ? reg.scope !== 'overlay' || reg.overlayId !== top.id : reg.scope !== 'global') { matchers.current.delete(id); continue; }
      if (reg.when === 'not-editable' && (terminal || isEditableTarget(e.target))) { matchers.current.delete(id); continue; }
      const spec = reg.action.startsWith('local:') ? reg.spec : currentBindings[reg.action as HotkeyAction];
      if (!spec) continue;
      const signature = `${JSON.stringify(spec)}:${interval}`;
      let entry = matchers.current.get(id);
      if (!entry || entry.spec !== signature) { entry = { spec: signature, matcher: createChordMatcher(spec, interval) }; matchers.current.set(id, entry); }
      if (entry.matcher.feed(e, performance.now()) !== 'matched') continue;
      handled.current.set(e, true);
      if (e.key === 'Escape' && reg.scope === 'overlay') {
        const topId = top?.id;
        setTimeout(() => { if (!e.defaultPrevented && state.current.stack.at(-1)?.id === topId && registrations.current.has(id)) reg.handler(e); });
      } else { e.preventDefault(); reg.handler(e); }
      return true;
    }
    handled.current.set(e, false);
    return false;
  };
  const dispatchRef = useRef(dispatch); dispatchRef.current = dispatch;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => { dispatchRef.current(e, false); };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, []);
  useEffect(() => {
    const top = stack.at(-1)?.element;
    const root = document.getElementById('root');
    const targets = stack.slice(0, -1).map(entry => entry.element);
    if (top && root && !root.contains(top)) targets.push(root);
    const previous = targets.map(element => [element, element.inert] as const);
    targets.forEach(element => { if (top && !element.contains(top)) element.inert = true; });
    const focusTarget = [...pendingFocus.current].reverse().find(element => element.isConnected && !isInert(element));
    pendingFocus.current = [];
    focusTarget?.focus();
    return () => previous.forEach(([element, inert]) => { element.inert = inert; });
  }, [stack]);
  const setBinding = (action: HotkeyAction, spec: KeySpec | null) => {
    if (spec && findConflictingAction(bindings, action, spec)) return 'conflict' as const;
    const next = { ...bindings, [action]: spec };
    if (!saveBindings(next)) return 'storage-error' as const;
    setBindings(next); return 'ok' as const;
  };
  const setChordMs = (ms: number) => { if (!saveChordMs(ms)) return 'storage-error' as const; updateChordMs(ms); return 'ok' as const; };
  const stable = useRef<StableContextValue>({ register, addOverlay, dispatchFromTerminal: e => dispatchRef.current(e, true) });
  return <StableContext.Provider value={stable.current}><BindingsContext.Provider value={{ bindings, chordMs, setBinding, setChordMs }}><StackContext.Provider value={stack}>{children}</StackContext.Provider></BindingsContext.Provider></StableContext.Provider>;
}

export function useHotkey(reg: HotkeyRegistration, enabled = true): void {
  const { register } = useStableContext();
  const ref = useRef(reg); ref.current = reg;
  const id = useRef(Symbol('hotkey'));
  const registerRef = useRef(register); registerRef.current = register;
  useEffect(() => enabled ? registerRef.current(id.current, ref) : undefined, [enabled]);
}
export function useHotkeyBindings(): Pick<HotkeysContextValue, 'bindings' | 'setBinding' | 'chordMs' | 'setChordMs'> {
  const value = useContext(BindingsContext);
  if (!value) throw new Error('HotkeyProvider is required');
  return value;
}
export function useHotkeyDispatch(): Pick<HotkeysContextValue, 'dispatchFromTerminal'> {
  const { dispatchFromTerminal } = useStableContext(); return { dispatchFromTerminal };
}
export function useOverlayStack(open: boolean, elementRef: RefObject<HTMLElement | null>, returnFocus = false): { id: symbol; isTop: boolean } {
  const { addOverlay } = useStableContext();
  const stack = useContext(StackContext);
  const id = useRef(Symbol('overlay'));
  const addRef = useRef(addOverlay); addRef.current = addOverlay;
  const wasOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  // Captured while rendering: a child's autoFocus moves focus before any effect of this hook runs.
  if (open && !wasOpen.current) opener.current = returnFocus && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  useEffect(() => {
    if (!open || !elementRef.current) return;
    return addRef.current(id.current, elementRef.current, opener.current);
  }, [open, elementRef]);
  return { id: id.current, isTop: stack.at(-1)?.id === id.current };
}
