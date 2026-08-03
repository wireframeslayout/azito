import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { useNotificationChannel } from './useNotificationChannel';
import type { PersistedTab } from './useTabPersistence';
import type { Project, Unit, Task, Server, Session, SidebarMode, Window } from '../pages/workspace/types';

export function useWorkspaceData(
  projectId: string | undefined,
  tabs: PersistedTab[],
  sidebarMode: SidebarMode,
) {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Latest projectId, read after awaits in refreshWorkspace/refreshSessions to discard
  // stale responses when the user switches projects again before a request resolves
  // (e.g. A -> B -> A: B's late response must not clobber A's already-current data).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const [project, setProject] = useState<Project | null>(null);
  const [allUnits, setAllUnits] = useState<Unit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [sessionData, setSessionData] = useState<Record<string, Session[]>>({});

  // Project list for cross-project tab colors
  const [projectList, setProjectList] = useState<{ id: number; name: string }[]>([]);

  // Project list for the project switcher menu
  const [allProjects, setAllProjects] = useState<Array<{ id: number; name: string; icon?: string; color?: string; windows?: Array<{ serverName: string; tmuxTarget: string }> }>>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  useEffect(() => {
    api<Array<{ id: number; name: string; icon?: string; color?: string; windows?: Array<{ serverName: string; tmuxTarget: string }> }>>('/projects').then((data) => {
      setAllProjects(data);
      setProjectsLoaded(true);
    }).catch(() => {});
  }, []);

  // All tasks (cross-project fallback for TaskPanel and findTaskByTarget)
  const [allTasks, setAllTasks] = useState<Task[]>([]);

  // File browser: per-server file browsing
  const [projectServers, setProjectServers] = useState<{serverName: string; workingDirectory?: string}[]>([]);
  const [selectedFileServer, setSelectedFileServer] = useState<string>(() =>
    localStorage.getItem(`workspace-file-server-${projectId}`) || ''
  );

  const refreshWorkspace = useCallback(async () => {
    const requestedProjectId = projectId;
    const pid = parseInt(projectId || '', 10);
    if (!pid) return;
    const [proj, allUn, allTsk, srvs, allProj] = await Promise.all([
      api<Project & { error?: string }>(`/projects/${pid}`),
      api<Unit[]>('/units'),
      api<Task[]>('/tasks'),
      api<Server[]>('/servers'),
      api<Array<{ id: number; name: string; icon?: string; color?: string; windows?: Array<{ serverName: string; tmuxTarget: string }> }>>('/projects'),
    ]);
    if (projectIdRef.current !== requestedProjectId) return; // stale response, a newer project is now active
    if ((proj as any).error) return;
    setProject(proj);
    setAllUnits(allUn);
    setAllTasks(allTsk);
    setTasks(allTsk.filter((t) => t.projectId === pid));
    setServers(srvs);
    setAllProjects(allProj);
    setProjectsLoaded(true);
  }, [projectId]);

  const refreshSessions = useCallback(async () => {
    const requestedProjectId = projectId;
    const pid = parseInt(projectId || '', 10);
    if (!pid) return;
    const proj = await api<Project & { error?: string }>(`/projects/${pid}`).catch(() => null);
    if (projectIdRef.current !== requestedProjectId) return; // stale response, a newer project is now active
    if (!proj || (proj as any).error) return;
    const projectServerNames = (proj.windows || []).map((w: Window) => w.serverName);
    const tabServerNames = tabsRef.current
      .filter((t) => t.type === 'terminal' && t.serverName)
      .map((t) => t.serverName!);
    const serverNames = [...new Set([...projectServerNames, ...tabServerNames])];
    const results = await Promise.allSettled(serverNames.map(async (name) => {
      const r = await api<Session[]>(`/servers/${name}/sessions`);
      return { name, sessions: Array.isArray(r) ? r : [] };
    }));
    if (projectIdRef.current !== requestedProjectId) return; // stale response, a newer project is now active
    const freshSessions: Record<string, Session[]> = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        freshSessions[r.value.name] = r.value.sessions;
      }
    }
    setSessionData((prev) => ({ ...prev, ...freshSessions }));
  }, [projectId]);

  // Event-driven refresh via WebSocket
  useNotificationChannel({
    onSessionsUpdated: useCallback(() => {
      refreshSessions();
    }, [refreshSessions]),
    onTaskStatus: useCallback(() => {
      refreshWorkspace();
    }, [refreshWorkspace]),
    onWorkspaceRefresh: useCallback(() => {
      refreshWorkspace();
      refreshSessions();
    }, [refreshWorkspace, refreshSessions]),
  });

  // Initial fetch + fallback polling (60s safety net for WS disconnects)
  useEffect(() => {
    refreshWorkspace();
    refreshSessions();
    const fallback = setInterval(() => {
      refreshWorkspace();
      if (sidebarMode === 'windows') refreshSessions();
    }, 60000);
    return () => clearInterval(fallback);
  }, [refreshWorkspace, refreshSessions, sidebarMode]);

  // Load project list for project bar
  useEffect(() => {
    api<{ id: number; name: string }[]>('/projects').then(setProjectList).catch(() => {});
  }, []);

  // Fetch project servers for file browser
  useEffect(() => {
    if (!projectId) return;
    api<{serverName: string; workingDirectory?: string}[]>(`/projects/${projectId}/servers`)
      .then(res => {
        const list = Array.isArray(res) ? res : [];
        setProjectServers(list);
        if (list.length > 0) {
          const saved = localStorage.getItem(`workspace-file-server-${projectId}`) || '';
          const valid = list.find(s => s.serverName === saved);
          setSelectedFileServer(valid ? saved : list[0].serverName);
        }
      })
      .catch(() => setProjectServers([]));
  }, [projectId]);

  // Persist selected file server
  useEffect(() => {
    if (projectId && selectedFileServer) localStorage.setItem(`workspace-file-server-${projectId}`, selectedFileServer);
  }, [selectedFileServer, projectId]);

  return {
    project,
    allUnits,
    tasks,
    servers,
    sessionData,
    projectList,
    allProjects,
    allTasks,
    projectsLoaded,
    projectServers,
    selectedFileServer,
    setSelectedFileServer,
    refreshWorkspace,
    refreshSessions,
  };
}
