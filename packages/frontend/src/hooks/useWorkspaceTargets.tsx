import { createContext, useCallback, useContext, useState } from 'react';

interface WorkspaceTargetsContextValue {
  onOpenInTerminal: ((serverName: string, target: string) => void) | null;
  setOnOpenInTerminal: (cb: ((serverName: string, target: string) => void) | null) => void;
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

function makeTargetKey(serverName: string, target: string): string {
  return `${serverName}::${target}`;
}

export { makeTargetKey as activityKey };

export function WorkspaceTargetsProvider({ children }: { children: React.ReactNode }) {
  const [onOpenInTerminal, setOnOpenInTerminal] = useState<((serverName: string, target: string) => void) | null>(null);
  const [onOpenTask, setOnOpenTask] = useState<((taskId: number) => void) | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [focusedTarget, setFocusedTarget] = useState<string | null>(null);
  const [onOpenTabSwitcher, setOnOpenTabSwitcher] = useState<(() => void) | null>(null);

  const setOnOpenInTerminalCb = useCallback((cb: ((serverName: string, target: string) => void) | null) => {
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
