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

  const setOnOpenInTerminalCb = useCallback((cb: ((serverName: string, target: string) => void) | null) => {
    setOnOpenInTerminal(() => cb);
  }, []);

  const setOnOpenTaskCb = useCallback((cb: ((taskId: number) => void) | null) => {
    setOnOpenTask(() => cb);
  }, []);

  return (
    <WorkspaceTargetsContext.Provider value={{ onOpenInTerminal, setOnOpenInTerminal: setOnOpenInTerminalCb, onOpenTask, setOnOpenTask: setOnOpenTaskCb, activeTabId, setActiveTabId, focusedTarget, setFocusedTarget }}>
      {children}
    </WorkspaceTargetsContext.Provider>
  );
}

export function useWorkspaceTargets() {
  return useContext(WorkspaceTargetsContext);
}
