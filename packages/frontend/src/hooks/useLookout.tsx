import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { buildWindowIndex, type ActivityTitleData } from '../lib/windowDisplay';
import { buildLookoutSections, type LookoutSections } from '../lib/lookoutSummary';
import { useActiveWindowRows } from './useActiveWindowRows';
import { useWorkspaceCatalog } from './useWorkspaceCatalog';

const STORAGE_KEY = 'azito-lookout-last-seen';
function parseLastSeen(value: string | null): number {
  if (value === null || value.trim() === '') return 0;
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 ? time : 0;
}
function readLastSeen(): number {
  try { return parseLastSeen(localStorage.getItem(STORAGE_KEY)); } catch { return 0; }
}
interface LookoutContextValue {
  sections: LookoutSections;
  rows: ReturnType<typeof useActiveWindowRows>['rows'];
  historyCount: number;
  setWorkspaceTitleData: (data: ActivityTitleData | null) => void;
  open: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}
const Context = createContext<LookoutContextValue | null>(null);
export function LookoutProvider({ children }: { children: React.ReactNode }) {
  const { allProjects, allTasks } = useWorkspaceCatalog();
  const data = useMemo(() => ({ windowById: buildWindowIndex(allProjects, allTasks), taskById: new Map(allTasks.map(task => [task.id, task])) }), [allProjects, allTasks]);
  const [workspaceTitleData, setWorkspaceTitleData] = useState<ActivityTitleData | null>(null);
  const { rows, historyCount } = useActiveWindowRows(workspaceTitleData ?? data);
  const [lastSeen, setLastSeen] = useState(readLastSeen);
  const [drawer, setDrawer] = useState<{ openedAt: number; lastSeen: number } | null>(null);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) setLastSeen(event.key === null ? 0 : parseLastSeen(event.newValue)); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const sections = useMemo(() => buildLookoutSections({ rows, allTasks, lastSeenMs: drawer?.lastSeen ?? lastSeen }), [rows, allTasks, drawer, lastSeen]);
  const openDrawer = () => setDrawer(current => current ?? { openedAt: Date.now(), lastSeen });
  const closeDrawer = () => {
    if (!drawer) return;
    setLastSeen(drawer.openedAt);
    try { localStorage.setItem(STORAGE_KEY, String(drawer.openedAt)); } catch { /* Session-only when storage is unavailable. */ }
    setDrawer(null);
  };
  return <Context.Provider value={{ sections, rows, historyCount, setWorkspaceTitleData, open: drawer !== null, openDrawer, closeDrawer }}>{children}</Context.Provider>;
}
export function useLookout(): LookoutContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useLookout must be used within LookoutProvider');
  return value;
}
