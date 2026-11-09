import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useHotkey } from './useHotkeys';
import { useIsMobile } from './useIsMobile';
import type { MaximizeTab } from '../lib/maximizeTreeModel';
import type { Window } from '../pages/workspace/types';

export interface MaximizeWorkspace {
  tabs: MaximizeTab[];
  activeWindowId: number | null;
  activeTabId: string | null;
  windows: ReadonlyMap<number, Window>;
  openWindowTab: (windowId: number) => void;
  wakeWindow: (window: Window) => Promise<void>;
}
interface MaximizeActions {
  setWorkspace: (workspace: MaximizeWorkspace | null) => void;
  open: (windowId: number, window?: Window) => void;
  rememberWindow: (window: Window) => void;
  forgetWindow: (id: number) => void;
  select: (windowId: number) => void;
  close: () => void;
}
interface MaximizeState {
  selectedWindowId: number | null;
  workspace: MaximizeWorkspace | null;
  extraWindows: ReadonlyMap<number, Window>;
  isMobile: boolean;
}
type ContextValue = MaximizeActions & MaximizeState;
const ActionsContext = createContext<MaximizeActions | null>(null);
const StateContext = createContext<MaximizeState | null>(null);
export function MaximizedWindowProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [workspace, setWorkspace] = useState<MaximizeWorkspace | null>(null);
  const [extraWindows, setExtraWindows] = useState<ReadonlyMap<number, Window>>(new Map());
  const rememberWindow = useCallback((window: Window) => setExtraWindows(previous => new Map(previous).set(window.id, window)), []);
  const forgetWindow = useCallback((id: number) => setExtraWindows(previous => {
    if (!previous.has(id)) return previous;
    const next = new Map(previous); next.delete(id); return next;
  }), []);
  const [selectedWindowId, setSelectedWindowId] = useState<number | null>(null);
  const current = useRef({ isMobile, workspace });
  current.current = { isMobile, workspace };
  const open = useCallback((id: number, window?: Window) => { if (!current.current.isMobile) { if (window && !current.current.workspace?.windows.has(id)) rememberWindow(window); setSelectedWindowId(id); } }, [rememberWindow]);
  useEffect(() => {
    if (!workspace) return;
    setExtraWindows(previous => {
      if (![...previous.keys()].some(id => workspace.windows.has(id))) return previous;
      return new Map([...previous].filter(([id]) => !workspace.windows.has(id)));
    });
  }, [workspace]);
  const close = useCallback(() => { setSelectedWindowId(null); setExtraWindows(new Map()); }, []);
  useEffect(() => { if (isMobile) close(); }, [isMobile, close]);
  useHotkey({ action: 'maximize.open', scope: 'global', when: 'always', handler: () => { if (workspace?.activeWindowId != null) open(workspace.activeWindowId); } }, !isMobile && selectedWindowId === null && workspace?.activeWindowId != null);
  const actions = useMemo<MaximizeActions>(() => ({ setWorkspace, open, rememberWindow, forgetWindow, select: setSelectedWindowId, close }), [open, rememberWindow, forgetWindow, close]);
  const state = useMemo<MaximizeState>(() => ({ selectedWindowId, workspace, extraWindows, isMobile }), [selectedWindowId, workspace, extraWindows, isMobile]);
  return <ActionsContext.Provider value={actions}><StateContext.Provider value={state}>{children}</StateContext.Provider></ActionsContext.Provider>;
}
export function useOptionalMaximizedWindow(): MaximizeActions | null { return useContext(ActionsContext); }
export function useMaximizeActions(): MaximizeActions {
  const value = useContext(ActionsContext);
  if (!value) throw new Error('MaximizedWindowProvider is required');
  return value;
}
export function useMaximizedWindow(): ContextValue {
  const actions = useMaximizeActions();
  const state = useContext(StateContext);
  if (!state) throw new Error('MaximizedWindowProvider is required');
  return { ...actions, ...state };
}
