import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiWithStatus } from '../api/client';
import { PROJECTS_CHANGED_EVENT } from '../lib/projectsChanged';
import type { ProjectListItem, Task } from '../pages/workspace/types';
import { useNotificationChannel } from './useNotificationChannel';

interface Catalog {
  allProjects: ProjectListItem[];
  allTasks: Task[];
  projectsLoaded: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

const Context = createContext<Catalog | null>(null);

export function WorkspaceCatalogProvider({ children }: { children: React.ReactNode }) {
  const sequence = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const [projects, tasks] = await Promise.all([apiWithStatus<unknown>('/projects'), apiWithStatus<unknown>('/tasks')]);
      if (projects.status < 200 || projects.status >= 300 || tasks.status < 200 || tasks.status >= 300 || !Array.isArray(projects.body) || !Array.isArray(tasks.body)) throw new Error('Failed to load workspace catalog');
      if (mounted.current && request === sequence.current) setState(prev => ({ ...prev, allProjects: projects.body as ProjectListItem[], allTasks: tasks.body as Task[], projectsLoaded: true, loading: false, error: null }));
    } catch (error) {
      if (mounted.current && request === sequence.current) setState(prev => ({ ...prev, loading: false, error: error instanceof Error ? error : new Error(String(error)) }));
    }
  }, []);
  const [state, setState] = useState<Catalog>(() => ({ allProjects: [], allTasks: [], projectsLoaded: false, loading: true, error: null, refresh }));
  useNotificationChannel({ onTaskStatus: refresh, onWorkspaceRefresh: refresh, onWindowRenamed: (event) => { if (event.windowId != null) void refresh(); } });
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onChanged = () => { void refresh(); };
    window.addEventListener(PROJECTS_CHANGED_EVENT, onChanged);
    const timer = setInterval(onChanged, 60000);
    return () => { mounted.current = false; sequence.current++; window.removeEventListener(PROJECTS_CHANGED_EVENT, onChanged); clearInterval(timer); };
  }, [refresh]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}

export function useWorkspaceCatalog(): Catalog {
  const value = useContext(Context);
  if (!value) throw new Error('useWorkspaceCatalog must be used within WorkspaceCatalogProvider');
  return value;
}
