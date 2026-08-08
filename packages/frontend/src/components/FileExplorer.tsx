import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchBlob } from '../api/client';
import { useToast } from '../hooks/useToast';
import { Icon } from './ui/Icon';
import { LoadingState } from './ui';
import { useContextMenu } from './ContextMenu';
import ContextMenu from './ContextMenu';
import { useLongPress } from '../hooks/useLongPress';
import { useFileTree } from './files/useFileTree';
import type { TreeNode } from './files/useFileTree';
import { useFileCrud } from './files/useFileCrud';
import FileTree from './files/FileTree';
import DeleteConfirmModal from './files/DeleteConfirmModal';

export { FilePreviewPanel } from './files/FilePreviewPanel';

export interface FileExplorerProps {
  serverName: string;
  rootPath: string;
  projectId?: number;
  onFileSelect?: (serverName: string, filePath: string) => void;
}

export default function FileExplorer({ serverName, rootPath, projectId, onFileSelect }: FileExplorerProps) {
  const { t } = useTranslation('files');
  const { showToast } = useToast();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const { tree, loading, error, loadRoot, toggleDir, expandDir, refreshDir, getSiblingNames } = useFileTree(serverName, rootPath);
  const { menu: contextMenu, show: showContextMenu, showAt: showContextMenuAt, hide: hideContextMenu } = useContextMenu();
  const bindLongPress = useLongPress();

  const crud = useFileCrud({
    serverName,
    projectId,
    expandDir,
    refreshDir,
    onFileCreated: (filePath) => {
      setSelectedPath(filePath);
      onFileSelect?.(serverName, filePath);
    },
  });

  const handleClick = useCallback((node: TreeNode) => {
    if (node.type === 'directory') {
      toggleDir(node.path);
    } else {
      setSelectedPath(node.path);
      onFileSelect?.(serverName, node.path);
    }
  }, [toggleDir, serverName, onFileSelect]);

  const buildMenuItems = useCallback((node: TreeNode) => {
    const isDir = node.type === 'directory';
    const parentPath = isDir ? node.path : (node.path.substring(0, node.path.lastIndexOf('/')) || rootPath);
    return [
      { label: t('explorer.newFile'), icon: <Icon name="file-plus" size={14} />, onClick: () => crud.startCreate(parentPath, 'file') },
      { label: t('explorer.newFolder'), icon: <Icon name="folder-plus" size={14} />, onClick: () => crud.startCreate(parentPath, 'directory') },
      { separator: true, label: '', onClick: () => {} },
      { label: t('explorer.rename'), icon: <Icon name="edit" size={14} />, onClick: () => crud.startRename(node.path, node.name) },
      { label: t('explorer.copyPath'), icon: <Icon name="clipboard" size={14} />, onClick: () => { navigator.clipboard.writeText(node.path); showToast(t('explorer.pathCopied')); } },
      {
        label: t('explorer.download'),
        icon: <Icon name="download" size={14} />,
        disabled: isDir,
        title: isDir ? t('explorer.downloadNotSupported') : undefined,
        onClick: () => {
          if (isDir) return;
          fetchBlob(`/servers/${encodeURIComponent(serverName)}/files/download?path=${encodeURIComponent(node.path)}`)
            .then((blob) => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = node.name;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            })
            .catch(() => showToast(t('explorer.downloadFailed')));
        },
      },
      { separator: true, label: '', onClick: () => {} },
      { label: t('explorer.delete'), icon: <Icon name="trash" size={14} />, danger: true, onClick: () => crud.startDelete(node.path, node.type) },
    ];
  }, [t, crud, rootPath, serverName, showToast]);

  const handleContextMenu = useCallback((node: TreeNode, e: React.MouseEvent) => {
    showContextMenu(e, buildMenuItems(node));
  }, [showContextMenu, buildMenuItems]);

  const handleLongPress = useCallback((node: TreeNode, x: number, y: number) => {
    showContextMenuAt(x, y, buildMenuItems(node));
  }, [showContextMenuAt, buildMenuItems]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        fontSize: 'var(--font-xs)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: 'var(--text-dim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Explorer
        </span>
        <button
          onClick={loadRoot}
          title={t('explorer.refresh')}
          className="icon-btn"
          style={{
            border: 'none', color: 'var(--text-dim)',
            cursor: 'pointer', fontSize: 'var(--font-base)', padding: '2px 6px',
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {/* Path breadcrumb */}
      <div style={{
        padding: '4px 12px',
        fontSize: 'var(--font-xs)',
        color: 'var(--text-dim)',
        borderBottom: '1px solid var(--border)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}>
        {rootPath}
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {loading && <LoadingState />}
        {error && <div style={{ padding: 12, fontSize: 'var(--font-sm)', color: 'var(--danger)' }}>{error}</div>}
        {!loading && !error && tree.length === 0 && (
          <div style={{ padding: 12, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('explorer.emptyDirectory')}</div>
        )}
        <FileTree
          nodes={tree}
          selectedPath={selectedPath}
          rootPath={rootPath}
          pendingCreate={crud.pendingCreate}
          pendingRename={crud.pendingRename}
          onSelect={handleClick}
          onContextMenu={handleContextMenu}
          onLongPress={handleLongPress}
          onCommitCreate={crud.commitCreate}
          onCancelCreate={crud.cancelCreate}
          onCommitRename={crud.commitRename}
          onCancelRename={crud.cancelRename}
          getSiblingNames={getSiblingNames}
          longPressHandlers={bindLongPress}
        />
      </div>

      {contextMenu && <ContextMenu menu={contextMenu} onClose={hideContextMenu} />}
      <DeleteConfirmModal
        target={crud.deleteTarget ? { ...crud.deleteTarget, serverName } : null}
        onConfirm={crud.confirmDelete}
        onClose={crud.cancelDelete}
        loading={crud.deleteLoading}
      />
    </div>
  );
}
