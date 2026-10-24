import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { HostPathApi } from '@azito/shared';
import { useToast } from '../../hooks/useToast';
import { parentOrRoot } from '../../lib/serverPath';

export interface PendingCreate {
  parentPath: string;
  type: 'file' | 'directory';
}

export interface PendingRename {
  path: string;
  name: string;
}

interface UseFileCrudOptions {
  serverName: string;
  projectId: number | undefined;
  rootPath: string;
  /** The path functions of the server's host OS. */
  pathApi: HostPathApi;
  loadRoot: () => Promise<void>;
  expandDir: (path: string) => Promise<void>;
  refreshDir: (path: string) => Promise<void>;
  onFileCreated?: (filePath: string) => void;
}

export function useFileCrud({ serverName, projectId, rootPath, pathApi, loadRoot, expandDir, refreshDir, onFileCreated }: UseFileCrudOptions) {
  const { t } = useTranslation('files');
  const { showToast } = useToast();
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; type: 'file' | 'directory' } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const startCreate = useCallback(async (parentPath: string, type: 'file' | 'directory') => {
    await expandDir(parentPath);
    setPendingCreate({ parentPath, type });
    setPendingRename(null);
  }, [expandDir]);

  const commitCreate = useCallback(async (name: string) => {
    if (!pendingCreate || !projectId) return;
    const fullPath = pathApi.join(pendingCreate.parentPath, name);
    try {
      const res = await api<{ ok?: boolean; error?: string }>(`/servers/${serverName}/files`, {
        method: 'POST',
        body: JSON.stringify({ projectId, path: fullPath, type: pendingCreate.type }),
      });
      if (res.error) throw new Error(res.error);
      setPendingCreate(null);
      if (pendingCreate.parentPath === rootPath) {
        await loadRoot();
      } else {
        await refreshDir(pendingCreate.parentPath);
      }
      if (pendingCreate.type === 'file' && onFileCreated) {
        onFileCreated(fullPath);
      }
    } catch {
      showToast(t('explorer.createFailed'));
    }
  }, [pendingCreate, projectId, serverName, rootPath, pathApi, loadRoot, refreshDir, onFileCreated, showToast, t]);

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const startRename = useCallback((nodePath: string, nodeName: string) => {
    setPendingRename({ path: nodePath, name: nodeName });
    setPendingCreate(null);
  }, []);

  const commitRename = useCallback(async (newName: string) => {
    if (!pendingRename || !projectId) return;
    try {
      const res = await api<{ ok?: boolean; error?: string }>(`/servers/${serverName}/files`, {
        method: 'PATCH',
        body: JSON.stringify({ projectId, path: pendingRename.path, newName }),
      });
      if (res.error) throw new Error(res.error);
      const parentDir = parentOrRoot(pathApi, pendingRename.path, rootPath);
      setPendingRename(null);
      if (parentDir === rootPath) {
        await loadRoot();
      } else {
        await refreshDir(parentDir);
      }
    } catch {
      showToast(t('explorer.renameFailed'));
    }
  }, [pendingRename, projectId, serverName, rootPath, pathApi, loadRoot, refreshDir, showToast, t]);

  const cancelRename = useCallback(() => setPendingRename(null), []);

  const startDelete = useCallback((nodePath: string, nodeType: 'file' | 'directory') => {
    setDeleteTarget({ path: nodePath, type: nodeType });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !projectId) return;
    setDeleteLoading(true);
    try {
      const res = await api<{ ok?: boolean; error?: string }>(`/servers/${serverName}/files`, {
        method: 'DELETE',
        body: JSON.stringify({ projectId, path: deleteTarget.path }),
      });
      if (res.error) throw new Error(res.error);
      const parentDir = parentOrRoot(pathApi, deleteTarget.path, rootPath);
      setDeleteTarget(null);
      if (parentDir === rootPath) {
        await loadRoot();
      } else {
        await refreshDir(parentDir);
      }
    } catch {
      showToast(t('explorer.deleteFailed'));
    }
    setDeleteLoading(false);
  }, [deleteTarget, projectId, serverName, rootPath, pathApi, loadRoot, refreshDir, showToast, t]);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  return {
    pendingCreate,
    pendingRename,
    deleteTarget,
    deleteLoading,
    startCreate,
    commitCreate,
    cancelCreate,
    startRename,
    commitRename,
    cancelRename,
    startDelete,
    confirmDelete,
    cancelDelete,
  };
}
