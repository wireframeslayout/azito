import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../api/client';
import { matchWorkspacePath, paths } from '../paths';
import type { TerminalOpenTarget } from '../lib/terminalTargetOpen';
import { useWorkspaceTargets } from './useWorkspaceTargets';
import { useWorkspaceCatalog } from './useWorkspaceCatalog';
import { useToast } from './useToast';

interface Navigation {
  openTask: (taskId: number, projectId?: number) => void;
  openTerminal: (req: TerminalOpenTarget, projectId?: number) => void;
}
type Pending = { type: 'task'; taskId: number; projectId: number } | { type: 'terminal'; req: TerminalOpenTarget; projectId: number };
const Context = createContext<Navigation | null>(null);

export function CrossProjectNavigationProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { onOpenTask, onOpenInTerminal } = useWorkspaceTargets();
  const { allTasks } = useWorkspaceCatalog();
  const { showToast } = useToast();
  const { t } = useTranslation('notifications');
  const pending = useRef<Pending | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousTarget = useRef<unknown>(null);
  const sequence = useRef(0);
  const clear = useCallback(() => { pending.current = null; if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  useEffect(() => () => { sequence.current++; clear(); }, [clear]);
  const queue = useCallback((item: Pending) => {
    clear();
    const match = matchWorkspacePath(location.pathname);
    if (match && Number(match.id) === item.projectId) {
      if (item.type === 'task') onOpenTask?.(item.taskId); else onOpenInTerminal?.(item.req);
      return;
    }
    previousTarget.current = item.type === 'task' ? onOpenTask : onOpenInTerminal;
    pending.current = item;
    timer.current = setTimeout(clear, 5000);
    navigate(paths.workspace(item.projectId));
  }, [clear, location.pathname, navigate, onOpenTask, onOpenInTerminal]);
  const openTask = useCallback((taskId: number, projectId?: number) => {
    const request = ++sequence.current;
    clear();
    const known = allTasks.find(task => task.id === taskId);
    const resolved = known?.projectId ?? projectId;
    if (typeof resolved === 'number') { queue({ type: 'task', taskId, projectId: resolved }); return; }
    void apiWithStatus<unknown>(`/tasks/${taskId}`).then(({ status, body }) => {
      if (request !== sequence.current) return;
      if (status < 200 || status >= 300 || typeof body !== 'object' || body === null || typeof (body as { projectId?: unknown }).projectId !== 'number') throw new Error('Task project unavailable');
      queue({ type: 'task', taskId, projectId: (body as { projectId: number }).projectId });
    }).catch(() => { if (request === sequence.current) showToast(t('taskOpenFailed')); });
  }, [allTasks, clear, queue, showToast, t]);
  const openTerminal = useCallback((req: TerminalOpenTarget, projectId?: number) => {
    sequence.current++;
    clear();
    if (projectId === undefined) { onOpenInTerminal?.(req); return; }
    queue({ type: 'terminal', req, projectId });
  }, [clear, onOpenInTerminal, queue]);
  useEffect(() => {
    const item = pending.current;
    const match = matchWorkspacePath(location.pathname);
    if (!item || !match || Number(match.id) !== item.projectId) return;
    if (item.type === 'task' && onOpenTask && onOpenTask !== previousTarget.current) { clear(); onOpenTask(item.taskId); }
    if (item.type === 'terminal' && onOpenInTerminal && onOpenInTerminal !== previousTarget.current) { clear(); onOpenInTerminal(item.req); }
  }, [location.pathname, onOpenTask, onOpenInTerminal, clear]);
  return <Context.Provider value={{ openTask, openTerminal }}>{children}</Context.Provider>;
}
export function useCrossProjectNavigation(): Navigation {
  const value = useContext(Context);
  if (!value) throw new Error('useCrossProjectNavigation must be used within CrossProjectNavigationProvider');
  return value;
}
