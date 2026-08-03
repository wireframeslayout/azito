import { useState, useEffect, useRef, useCallback } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { SidebarMode } from '../pages/workspace/types';
import { VALID_SIDEBAR_MODES } from '../pages/workspace/types';
import { paths } from '../paths';

export function useSidebarState(
  projectId: string | undefined,
  urlMode: string | undefined,
  _locationPathname: string,
  navigate: NavigateFunction,
) {
  const validModes = VALID_SIDEBAR_MODES;

  // Sidebar collapse (global)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => (localStorage.getItem('workspace-sidebar-collapsed') ?? localStorage.getItem(`workspace-sidebar-collapsed-${projectId}`)) === 'true');

  // Sidebar resize (global)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const global = localStorage.getItem('workspace-sidebar-width');
    if (global) return parseInt(global) || 320;
    const perProject = localStorage.getItem(`workspace-sidebar-width-${projectId}`);
    return parseInt(perProject || '') || 320;
  });
  const isResizingRef = useRef(false);

  // Repos mode (per project)
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(() => {
    const stored = localStorage.getItem(`workspace-repo-${projectId}`);
    return stored ? parseInt(stored, 10) : null;
  });

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    if (urlMode && validModes.includes(urlMode as SidebarMode)) return urlMode as SidebarMode;
    const saved = localStorage.getItem(`workspace-mode-${projectId}`) as SidebarMode;
    if (saved && validModes.includes(saved)) return saved;
    return 'windows';
  });

  const switchSidebarMode = useCallback((mode: SidebarMode) => {
    setSidebarMode(mode);
    if (projectId) {
      localStorage.setItem(`workspace-mode-${projectId}`, mode);
      navigate(paths.workspace(projectId, mode), { replace: true });
    }
  }, [projectId, navigate]);

  // URL -> sidebarMode sync
  useEffect(() => {
    if (urlMode && validModes.includes(urlMode as SidebarMode) && urlMode !== sidebarMode) {
      setSidebarMode(urlMode as SidebarMode);
    }
  }, [urlMode]);

  // Reset per-project state when project changes (Workspace never remounts)
  const prevIdRef = useRef(projectId);
  useEffect(() => {
    if (projectId && projectId !== prevIdRef.current) {
      prevIdRef.current = projectId;
      const savedRepo = localStorage.getItem(`workspace-repo-${projectId}`);
      setSelectedRepoId(savedRepo ? parseInt(savedRepo, 10) : null);
      const savedMode = localStorage.getItem(`workspace-mode-${projectId}`) as SidebarMode;
      if (savedMode && VALID_SIDEBAR_MODES.includes(savedMode)) {
        setSidebarMode(savedMode);
      } else {
        setSidebarMode('windows');
      }
    }
  }, [projectId]);

  // Persist sidebar collapsed state (global)
  useEffect(() => {
    localStorage.setItem('workspace-sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Persist sidebar width (global)
  useEffect(() => {
    localStorage.setItem('workspace-sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);

  // Persist selected repo (per project)
  useEffect(() => {
    if (projectId && selectedRepoId != null) localStorage.setItem(`workspace-repo-${projectId}`, String(selectedRepoId));
  }, [selectedRepoId, projectId]);

  // Sidebar resize handlers
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.min(600, Math.max(200, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  const handleResizeDoubleClick = useCallback(() => {
    setSidebarWidth(320);
  }, []);

  return {
    sidebarMode,
    setSidebarMode,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarWidth,
    setSidebarWidth,
    sidebarOpen,
    setSidebarOpen,
    selectedRepoId,
    setSelectedRepoId,
    switchSidebarMode,
    handleResizeMouseDown,
    handleResizeDoubleClick,
  };
}
