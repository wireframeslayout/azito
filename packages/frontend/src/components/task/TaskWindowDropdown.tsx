import React, { useCallback } from 'react';
import { WindowPaneTree, WindowActivityIndicator } from '../ui';
import { useClickOutside } from '../../hooks/useClickOutside';
import type { WindowItem } from '../ui/WindowPaneTree';
import type { Session } from '../../pages/workspace/types';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { isSameWindowTarget } from '../../utils/tmuxTarget';
import { useTranslation } from 'react-i18next';

interface TaskWindowDropdownProps {
  windows: WindowItem[];
  sessionData: Record<string, Session[]>;
  activeTarget: { serverName: string; target: string } | null;
  onPaneClick: (serverName: string, target: string) => void;
  onContextMenu?: (e: React.MouseEvent, w: WindowItem, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void;
  onLongPress?: (x: number, y: number, w: WindowItem, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void;
  onOpenAddWindow?: () => void;
  onClose: () => void;
  respawningWindowIds?: Set<number>;
}

export default function TaskWindowDropdown({
  windows, sessionData, activeTarget,
  onPaneClick, onContextMenu, onLongPress, onOpenAddWindow, onClose, respawningWindowIds,
}: TaskWindowDropdownProps) {
  const { t } = useTranslation('tasks');
  const ref = useClickOutside<HTMLDivElement>(onClose);
  const { windowIndicator, findFinished } = useAgentActivity();

  const checkActive = (serverName: string, target: string, level: 'window' | 'pane') =>
    !!activeTarget && activeTarget.serverName === serverName
    && (level === 'pane' ? activeTarget.target === target : isSameWindowTarget(activeTarget.target, target));

  const renderExtra = useCallback((w: WindowItem) => {
    const status = windowIndicator(w.serverName, w.tmuxTarget);
    if (!status) return null;
    const fe = status === 'finished' ? findFinished(w.serverName, w.tmuxTarget) : undefined;
    return <WindowActivityIndicator status={status} finishedAt={fe?.finishedAt} />;
  }, [windowIndicator, findFinished]);

  return (
    <div
      ref={ref}
      style={{
        // Anchored to the trigger's top-right (matches TabBar's own ▾ tab-list menu
        // pattern) — the trigger now lives in the pane's trailing area (right edge), so a
        // left:0 anchor would push the box off the right edge of the screen/pane.
        position: 'absolute', top: '100%', right: 0, zIndex: 100,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        minWidth: 'min(280px, calc(100vw - 16px))', maxWidth: 'min(400px, calc(100vw - 16px))',
        // Column flex + minHeight:0 on the scrollable child below is what lets the list grow
        // up to the box's own maxHeight and then actually scroll instead of just clipping —
        // "+ Add Window" stays pinned outside that scroll area as a footer.
        display: 'flex', flexDirection: 'column',
        maxHeight: 'min(400px, calc(100vh - 16px))',
      }}
    >
      <div style={{ overflowY: 'auto', overflowX: 'hidden', minHeight: 0, padding: '8px 0' }}>
        <WindowPaneTree
          windows={windows}
          sessionData={sessionData}
          isActive={checkActive}
          onPaneClick={(serverName, target) => {
            onPaneClick(serverName, target);
            onClose();
          }}
          onContextMenu={onContextMenu}
          onLongPress={onLongPress}
          extra={renderExtra}
          respawningWindowIds={respawningWindowIds}
        />
      </div>
      {onOpenAddWindow && (
        <button
          onClick={() => { onOpenAddWindow(); onClose(); }}
          style={{
            display: 'block', width: '100%', padding: '8px 12px', flexShrink: 0,
            fontSize: 'var(--font-sm)', color: 'var(--accent)', background: 'none',
            border: 'none', borderTop: '1px solid var(--border)',
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          {t('windowDropdown.addWindow')}
        </button>
      )}
    </div>
  );
}
