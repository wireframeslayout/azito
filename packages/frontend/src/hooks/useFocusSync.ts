import { useState, useCallback, useRef } from 'react';
import type { MuxFocusPayload } from '../types/notification';
import type { TerminalRef } from '../lib/terminalRef';
import { api } from '../api/client';

const LS_FOLLOW = 'follow-herdr';
const LS_REVERSE = 'focus-sync-reverse';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === 'true';
  } catch {
    return fallback;
  }
}

export interface FocusSyncActions {
  followEnabled: boolean;
  setFollowEnabled: (v: boolean) => void;
  reverseEnabled: boolean;
  setReverseEnabled: (v: boolean) => void;
  handleMuxFocus: (payload: MuxFocusPayload) => void;
  handleWindowSelect: (windowId: number) => void;
}

export function useFocusSync(
  activeTabId: string | null,
  allTasks: Array<{ id: number; title: string; projectId: number }>,
  openTask: (taskId: number, title: string, projectId?: number) => void,
  connectPane: (ref: TerminalRef | string, targetOrProjectId?: string | number, projectId?: number) => void,
): FocusSyncActions {
  const [followEnabled, setFollowRaw] = useState(() => readBool(LS_FOLLOW, false));
  const [reverseEnabled, setReverseRaw] = useState(() => readBool(LS_REVERSE, true));

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const setFollowEnabled = useCallback((v: boolean) => {
    setFollowRaw(v);
    try { localStorage.setItem(LS_FOLLOW, String(v)); } catch { /* ignore */ }
  }, []);

  const setReverseEnabled = useCallback((v: boolean) => {
    setReverseRaw(v);
    try { localStorage.setItem(LS_REVERSE, String(v)); } catch { /* ignore */ }
  }, []);

  const handleMuxFocus = useCallback((payload: MuxFocusPayload) => {
    if (!followEnabled) return;
    const { serverName, windowId, taskId } = payload;

    const currentTab = activeTabIdRef.current ?? '';
    if (currentTab.includes(`::w${windowId}.`)) return;

    if (taskId != null) {
      const task = allTasks.find((t) => t.id === taskId);
      if (task) {
        connectPane({ kind: 'windowId', serverName, windowId, pane: 1 });
        openTask(taskId, task.title, task.projectId);
      }
    } else {
      connectPane({ kind: 'windowId', serverName, windowId, pane: 1 });
    }
  }, [followEnabled, allTasks, openTask, connectPane]);

  const handleWindowSelect = useCallback((windowId: number) => {
    if (!reverseEnabled) return;
    api(`/windows/${windowId}/focus`, { method: 'POST' }).catch(() => {});
  }, [reverseEnabled]);

  return {
    followEnabled, setFollowEnabled,
    reverseEnabled, setReverseEnabled,
    handleMuxFocus,
    handleWindowSelect,
  };
}
