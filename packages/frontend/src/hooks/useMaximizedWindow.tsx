import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
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
interface ContextValue {
  selectedWindowId: number | null;
  workspace: MaximizeWorkspace | null;
  setWorkspace: (workspace: MaximizeWorkspace | null) => void;
  open: (windowId: number, window?: Window) => void;
  rememberWindow: (window: Window) => void;
  forgetWindow: (id: number) => void;
  extraWindows: ReadonlyMap<number, Window>;
  select: (windowId: number) => void;
  close: () => void;
  isMobile: boolean;
}
const Context = createContext<ContextValue | null>(null);
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
  const open = useCallback((id: number, window?: Window) => { if (!isMobile) { if (window && !workspace?.windows.has(id)) rememberWindow(window); setSelectedWindowId(id); } }, [isMobile, rememberWindow, workspace]);
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
  return <Context.Provider value={{ selectedWindowId, workspace, setWorkspace, open, rememberWindow, forgetWindow, extraWindows, select: setSelectedWindowId, close, isMobile }}>{children}</Context.Provider>;
}
export function useOptionalMaximizedWindow(): ContextValue | null { return useContext(Context); }
export function useMaximizedWindow(): ContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('MaximizedWindowProvider is required');
  return value;
}
