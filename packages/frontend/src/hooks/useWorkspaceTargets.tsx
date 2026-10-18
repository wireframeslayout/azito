import { createContext, useCallback, useContext, useState } from 'react';
import { windowKey } from '@azito/shared';
import type { TerminalOpenTarget } from '../lib/terminalTargetOpen';

interface WorkspaceTargetsContextValue {
  onOpenInTerminal: ((req: TerminalOpenTarget) => void) | null;
  setOnOpenInTerminal: (cb: ((req: TerminalOpenTarget) => void) | null) => void;
  onOpenTask: ((taskId: number) => void) | null;
  setOnOpenTask: (cb: ((taskId: number) => void) | null) => void;
  activeTabId: string | null;
  setActiveTabId: (id: string | null) => void;
  focusedTarget: string | null;
  setFocusedTarget: (key: string | null) => void;
  /** SP端末クイックキーフッター（Issue #69 T3）の右端▦から、TabContentRenderer 配下の
   *  TerminalContainer までタブスイッチャー開閉を prop drilling せずに届けるための登録口。 */
  onOpenTabSwitcher: (() => void) | null;
  setOnOpenTabSwitcher: (cb: (() => void) | null) => void;
}

const defaultValue: WorkspaceTargetsContextValue = {
  onOpenInTerminal: null,
  setOnOpenInTerminal: () => {},
  onOpenTask: null,
  setOnOpenTask: () => {},
  activeTabId: null,
  setActiveTabId: () => {},
  focusedTarget: null,
  setFocusedTarget: () => {},
  onOpenTabSwitcher: null,
  setOnOpenTabSwitcher: () => {},
};

const WorkspaceTargetsContext = createContext<WorkspaceTargetsContextValue>(defaultValue);

export { windowKey as activityKey };

export function WorkspaceTargetsProvider({ children }: { children: React.ReactNode }) {
  const [onOpenInTerminal, setOnOpenInTerminal] = useState<((req: TerminalOpenTarget) => void) | null>(null);
  const [onOpenTask, setOnOpenTask] = useState<((taskId: number) => void) | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [focusedTarget, setFocusedTarget] = useState<string | null>(null);
  const [onOpenTabSwitcher, setOnOpenTabSwitcher] = useState<(() => void) | null>(null);

  const setOnOpenInTerminalCb = useCallback((cb: ((req: TerminalOpenTarget) => void) | null) => {
    setOnOpenInTerminal(() => cb);
  }, []);

  const setOnOpenTaskCb = useCallback((cb: ((taskId: number) => void) | null) => {
    setOnOpenTask(() => cb);
  }, []);

  const setOnOpenTabSwitcherCb = useCallback((cb: (() => void) | null) => {
    setOnOpenTabSwitcher(() => cb);
  }, []);

  return (
    <WorkspaceTargetsContext.Provider value={{ onOpenInTerminal, setOnOpenInTerminal: setOnOpenInTerminalCb, onOpenTask, setOnOpenTask: setOnOpenTaskCb, activeTabId, setActiveTabId, focusedTarget, setFocusedTarget, onOpenTabSwitcher, setOnOpenTabSwitcher: setOnOpenTabSwitcherCb }}>
      {children}
    </WorkspaceTargetsContext.Provider>
  );
}

export function useWorkspaceTargets() {
  return useContext(WorkspaceTargetsContext);
}
