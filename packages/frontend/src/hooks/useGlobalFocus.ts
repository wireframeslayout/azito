import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import React from 'react';
import { isSameWindowTarget } from '../utils/tmuxTarget';

interface GlobalFocus {
  serverName: string | null;
  tmuxTarget: string | null;
  taskId: number | null;
}

interface GlobalFocusContextValue {
  focus: GlobalFocus;
  setFocus: (f: Partial<GlobalFocus>) => void;
  isFocusedServer: (serverName: string) => boolean;
  isFocusedWindow: (serverName: string, tmuxTarget: string) => boolean;
  isFocusedPane: (serverName: string, tmuxTarget: string) => boolean;
  isFocusedTask: (taskId: number) => boolean;
}

const INITIAL_FOCUS: GlobalFocus = { serverName: null, tmuxTarget: null, taskId: null };

const GlobalFocusContext = createContext<GlobalFocusContextValue>({
  focus: INITIAL_FOCUS,
  setFocus: () => {},
  isFocusedServer: () => false,
  isFocusedWindow: () => false,
  isFocusedPane: () => false,
  isFocusedTask: () => false,
});

export function GlobalFocusProvider({ children }: { children: ReactNode }) {
  const [focus, setFocusState] = useState<GlobalFocus>(INITIAL_FOCUS);

  const setFocus = useCallback((f: Partial<GlobalFocus>) => {
    setFocusState((prev) => {
      const next = { ...prev, ...f };
      if (next.serverName === prev.serverName && next.tmuxTarget === prev.tmuxTarget && next.taskId === prev.taskId) return prev;
      return next;
    });
  }, []);

  const isFocusedServer = useCallback((serverName: string) => {
    return focus.serverName === serverName;
  }, [focus.serverName]);

  // Window-level match: ignores pane suffix so a task's stored tmuxTarget (which may
  // carry a different pane index than the currently rendered pane) still highlights.
  const isFocusedWindow = useCallback((serverName: string, tmuxTarget: string) => {
    if (focus.serverName !== serverName || focus.tmuxTarget == null) return false;
    return isSameWindowTarget(focus.tmuxTarget, tmuxTarget);
  }, [focus.serverName, focus.tmuxTarget]);

  // Pane-level match: exact target equality, used to highlight a single expanded pane row.
  const isFocusedPane = useCallback((serverName: string, tmuxTarget: string) => {
    return focus.serverName === serverName && focus.tmuxTarget === tmuxTarget;
  }, [focus.serverName, focus.tmuxTarget]);

  const isFocusedTask = useCallback((taskId: number) => {
    return focus.taskId === taskId;
  }, [focus.taskId]);

  const value = useMemo(() => ({
    focus,
    setFocus,
    isFocusedServer,
    isFocusedWindow,
    isFocusedPane,
    isFocusedTask,
  }), [focus, setFocus, isFocusedServer, isFocusedWindow, isFocusedPane, isFocusedTask]);

  return React.createElement(GlobalFocusContext.Provider, { value }, children);
}

export function useGlobalFocus(): GlobalFocusContextValue {
  return useContext(GlobalFocusContext);
}
