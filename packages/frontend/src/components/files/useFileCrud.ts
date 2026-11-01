import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FilesBackend } from './backend/FilesBackend';
import type { HostPathApi } from '@azito/shared';
import { useToast } from '../../hooks/useToast';
import { joinRelative, parentOrRoot } from '../../lib/serverPath';

export interface PendingCreate {
  parentPath: string;
  type: 'file' | 'directory';
}

export interface PendingRename {
  path: string;
  name: string;
}

interface UseFileCrudOptions {
  backend: FilesBackend;
  rootPath: string;
  /** The path functions of the server's host OS. */
  pathApi: HostPathApi;
  loadRoot: () => Promise<void>;
  expandDir: (path: string) => Promise<void>;
  refreshDir: (path: string) => Promise<void>;
  onFileCreated?: (filePath: string) => void;
}

export function useFileCrud({ backend, rootPath, pathApi, loadRoot, expandDir, refreshDir, onFileCreated }: UseFileCrudOptions) {
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
    if (!pendingCreate) return;
    const fullPath = joinRelative(pathApi, pendingCreate.parentPath, name);
    try {
      const createdPath = await backend.create(fullPath, pendingCreate.type);
      setPendingCreate(null);
      if (pendingCreate.parentPath === rootPath) {
        await loadRoot();
      } else {
        await refreshDir(pendingCreate.parentPath);
      }
      if (pendingCreate.type === 'file' && onFileCreated) {
        onFileCreated(createdPath);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('explorer.createFailed'));
    }
  }, [pendingCreate, backend, rootPath, pathApi, loadRoot, refreshDir, onFileCreated, showToast, t]);

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const startRename = useCallback((nodePath: string, nodeName: string) => {
    setPendingRename({ path: nodePath, name: nodeName });
    setPendingCreate(null);
  }, []);

  const commitRename = useCallback(async (newName: string) => {
    if (!pendingRename) return;
    try {
      await backend.rename(pendingRename.path, newName);
      const parentDir = parentOrRoot(pathApi, pendingRename.path, rootPath);
      setPendingRename(null);
      if (parentDir === rootPath) {
        await loadRoot();
      } else {
        await refreshDir(parentDir);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('explorer.renameFailed'));
    }
  }, [pendingRename, backend, rootPath, pathApi, loadRoot, refreshDir, showToast, t]);

  const cancelRename = useCallback(() => setPendingRename(null), []);

  const startDelete = useCallback((nodePath: string, nodeType: 'file' | 'directory') => {
    setDeleteTarget({ path: nodePath, type: nodeType });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await backend.delete(deleteTarget.path, deleteTarget.type);
      const parentDir = parentOrRoot(pathApi, deleteTarget.path, rootPath);
      setDeleteTarget(null);
      if (parentDir === rootPath) {
        await loadRoot();
      } else {
        await refreshDir(parentDir);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('explorer.deleteFailed'));
    }
    setDeleteLoading(false);
  }, [deleteTarget, backend, rootPath, pathApi, loadRoot, refreshDir, showToast, t]);

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
