import React from 'react';
import { Icon } from '../ui/Icon';
import type { TreeNode } from './useFileTree';
import type { PendingCreate, PendingRename } from './useFileCrud';
import InlineNameInput from './InlineNameInput';

interface FileTreeProps {
  nodes: TreeNode[];
  selectedPath: string | null;
  rootPath: string;
  pendingCreate: PendingCreate | null;
  pendingRename: PendingRename | null;
  onSelect: (node: TreeNode) => void;
  onContextMenu: (node: TreeNode, e: React.MouseEvent) => void;
  onLongPress: (node: TreeNode, x: number, y: number) => void;
  onCommitCreate: (name: string) => void;
  onCancelCreate: () => void;
  onCommitRename: (newName: string) => void;
  onCancelRename: () => void;
  getSiblingNames: (parentPath: string) => string[];
  longPressHandlers: (onLongPress: (x: number, y: number) => void) => {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
  };
}

export default function FileTree({
  nodes, selectedPath, rootPath, pendingCreate, pendingRename,
  onSelect, onContextMenu, onLongPress,
  onCommitCreate, onCancelCreate, onCommitRename, onCancelRename,
  getSiblingNames, longPressHandlers,
}: FileTreeProps) {
  const renderNode = (node: TreeNode, depth: number): React.ReactElement => {
    const isDir = node.type === 'directory';
    const isSelected = node.path === selectedPath;
    const isRenaming = pendingRename?.path === node.path;

    if (isRenaming) {
      const parentPath = node.path.substring(0, node.path.lastIndexOf('/')) || rootPath;
      const siblings = getSiblingNames(parentPath).filter((n) => n !== node.name);
      return (
        <div key={node.path}>
          <InlineNameInput
            initialValue={node.name}
            kind={node.type}
            siblingNames={siblings}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
            depth={depth}
          />
        </div>
      );
    }

    return (
      <div key={node.path}>
        <div
          onClick={() => onSelect(node)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(node, e); }}
          {...longPressHandlers((x, y) => onLongPress(node, x, y))}
          className={`row-hover${isSelected ? ' row-selected' : ''}`}
          style={{
            padding: '3px 8px 3px ' + (8 + depth * 16) + 'px',
            fontSize: 'var(--font-md)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            color: isSelected ? 'var(--accent)' : 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            borderRadius: 'var(--radius-sm)',
            minHeight: 26,
            WebkitUserSelect: 'none',
            userSelect: 'none',
          }}
        >
          <span style={{ width: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--text-dim)' }}>
            {isDir ? <Icon name="chevron-right" size={14} rotate={node.expanded ? 90 : 0} /> : null}
          </span>
          <span style={{ width: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name={isDir ? (node.expanded ? 'folder-open' : 'files') : 'file'} size={14} />
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
          {!isDir && node.size != null && (
            <span style={{ marginLeft: 'auto', fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', flexShrink: 0 }}>
              {node.size < 1024 ? node.size + 'B' : Math.round(node.size / 1024) + 'KB'}
            </span>
          )}
        </div>
        {isDir && node.expanded && (
          <>
            {pendingCreate?.parentPath === node.path && (
              <InlineNameInput
                initialValue=""
                kind={pendingCreate.type}
                siblingNames={getSiblingNames(node.path)}
                onCommit={onCommitCreate}
                onCancel={onCancelCreate}
                depth={depth + 1}
              />
            )}
            {node.children?.map((child) => renderNode(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {pendingCreate?.parentPath === rootPath && (
        <InlineNameInput
          initialValue=""
          kind={pendingCreate.type}
          siblingNames={getSiblingNames(rootPath)}
          onCommit={onCommitCreate}
          onCancel={onCancelCreate}
          depth={0}
        />
      )}
      {nodes.map((node) => renderNode(node, 0))}
    </>
  );
}
