import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { api } from '../../api/client';
import { AgentIcon } from './AgentIcons';
import { useGlobalFocus } from '../../hooks/useGlobalFocus';
import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import type { Session, Window } from '../../pages/workspace/types';

export type WindowItem = Pick<Window, 'id' | 'serverName' | 'tmuxTarget' | 'label' | 'taskId'> & { windowType?: string; workerType?: string; isPrimary?: boolean };

type ContextMenuExtra = { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string };

interface WindowPaneTreeProps {
  windows: WindowItem[];
  sessionData: Record<string, Session[]>;
  isActive?: (serverName: string, target: string, level: 'window' | 'pane') => boolean;
  /**
   * クリックされた行の `WindowItem` 自体を第3引数で渡す（同じ物理ウィンドウを別々のタスクが
   * 持つ場合、呼び出し元が物理ターゲットから Map で引き直して取り違えないようにするため）。
   * 既存の呼び出し元（2引数のみ受け取る）は後方互換のため無視して構わない。
   */
  onPaneClick: (serverName: string, target: string, w: WindowItem) => void;
  onContextMenu?: (e: React.MouseEvent, w: WindowItem, extra?: ContextMenuExtra) => void;
  onLongPress?: (x: number, y: number, w: WindowItem, extra?: ContextMenuExtra) => void;
  extra?: (w: WindowItem) => React.ReactNode;
  activityClassName?: (w: WindowItem) => string | undefined;
  respawningWindowIds?: Set<number>;
  /** taskId バッジの見た目/挙動を差し替える（未指定なら既定の TaskIdBadge） */
  renderTaskBadge?: (w: WindowItem, taskId: number) => React.ReactNode;
  /** 行の副題（既定はペインのタイトル/コマンド）を差し替える。null/undefined を返すと既定表示のまま */
  renderSubtitle?: (w: WindowItem) => React.ReactNode | null | undefined;
  /** 行の主題（既定は w.label || tmux ウィンドウ名）を差し替える。null/undefined を返すと既定表示のまま */
  renderTitle?: (w: WindowItem) => React.ReactNode | null | undefined;
}

export function WindowPaneTree({ windows, sessionData, isActive, onPaneClick, onContextMenu, onLongPress, extra, activityClassName, respawningWindowIds, renderTaskBadge, renderSubtitle, renderTitle }: WindowPaneTreeProps) {
  const { t } = useTranslation('common');
  const [expandedWindows, setExpandedWindows] = useState<Set<string>>(() => new Set());

  const handleToggle = useCallback((key: string) => {
    setExpandedWindows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleUnzoom = useCallback(async (serverName: string, sessionName: string, windowName: string) => {
    const target = `${sessionName}:${windowName}`;
    try {
      await api(`/servers/${serverName}/panes/${encodeURIComponent(target)}/unzoom`, { method: 'POST' });
    } catch { /* best-effort */ }
  }, []);

  if (windows.length === 0) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', padding: '20px 0', textAlign: 'center' }}>
        {t('windowPaneTree.noWindows')}
      </div>
    );
  }

  return (
    <div>
      {windows.map((w) => (
        <WindowRow
          key={w.id}
          w={w}
          sessionData={sessionData}
          isActive={isActive}
          expandedWindows={expandedWindows}
          onToggle={handleToggle}
          onUnzoom={handleUnzoom}
          onPaneClick={onPaneClick}
          onContextMenu={onContextMenu}
          onLongPress={onLongPress}
          extra={extra?.(w)}
          activityClassName={activityClassName?.(w)}
          isRespawning={respawningWindowIds?.has(w.id)}
          renderTaskBadge={renderTaskBadge}
          renderSubtitle={renderSubtitle}
          renderTitle={renderTitle}
        />
      ))}
    </div>
  );
}

interface WindowRowProps {
  w: WindowItem;
  sessionData: Record<string, Session[]>;
  isActive?: (serverName: string, target: string, level: 'window' | 'pane') => boolean;
  expandedWindows: Set<string>;
  onToggle: (key: string) => void;
  onUnzoom: (serverName: string, sessionName: string, windowName: string) => void;
  onPaneClick: (serverName: string, target: string, w: WindowItem) => void;
  onContextMenu?: (e: React.MouseEvent, w: WindowItem, extra?: ContextMenuExtra) => void;
  onLongPress?: (x: number, y: number, w: WindowItem, extra?: ContextMenuExtra) => void;
  extra?: React.ReactNode;
  activityClassName?: string;
  isRespawning?: boolean;
  renderTaskBadge?: (w: WindowItem, taskId: number) => React.ReactNode;
  renderSubtitle?: (w: WindowItem) => React.ReactNode | null | undefined;
  renderTitle?: (w: WindowItem) => React.ReactNode | null | undefined;
}

const SPINNER_KEYFRAMES_ID = 'window-pane-tree-spinner-keyframes';

function ensureSpinnerKeyframes() {
  if (typeof document === 'undefined' || document.getElementById(SPINNER_KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = SPINNER_KEYFRAMES_ID;
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

function Spinner() {
  ensureSpinnerKeyframes();
  return (
    <span
      role="status"
      aria-label="respawning"
      className="window-respawn-spinner"
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        border: '2px solid var(--text-dim)',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
        flexShrink: 0,
      }}
    />
  );
}

function TaskIdBadge({ taskId }: { taskId: number }) {
  return (
    <span style={{
      fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--bg-2, var(--bg))',
      borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0,
    }}>
      #{taskId}
    </span>
  );
}

function OfflineRow({ w, active, onPaneClick, onContextMenu, onLongPress, extra, isRespawning, renderTaskBadge, renderSubtitle, renderTitle }: {
  w: WindowItem;
  active?: boolean;
  // Present so an offline/unmatched window is still selectable — see WindowRow's call
  // sites (session not found / tmux window not found). Opening its tab is still useful: the
  // caller (e.g. TerminalContainer) then owns showing its own "window not found /
  // reconnect" state, the same as any other window whose tmux side has since gone away.
  onPaneClick?: WindowRowProps['onPaneClick'];
  onContextMenu?: WindowRowProps['onContextMenu'];
  onLongPress?: WindowRowProps['onLongPress'];
  extra?: React.ReactNode;
  isRespawning?: boolean;
  renderTaskBadge?: (w: WindowItem, taskId: number) => React.ReactNode;
  renderSubtitle?: (w: WindowItem) => React.ReactNode | null | undefined;
  renderTitle?: (w: WindowItem) => React.ReactNode | null | undefined;
}) {
  const { t } = useTranslation('common');
  const bindLongPress = useLongPress();
  const clickable = !!onPaneClick;
  const subtitle = renderSubtitle?.(w);
  const title = renderTitle?.(w) ?? (w.label || w.tmuxTarget);
  return (
    <div
      onClick={onPaneClick ? () => onPaneClick(w.serverName, w.tmuxTarget, w) : undefined}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, w) : undefined}
      {...(onLongPress ? bindLongPress((x, y) => onLongPress(x, y, w)) : {})}
      className={clickable ? `row-hover${active ? ' row-selected' : ''}` : undefined}
      style={{
        ...((onContextMenu || onLongPress) ? longPressStyle : {}),
        padding: '6px 12px', fontSize: 'var(--font-md)', borderRadius: 'var(--radius-sm)', margin: '1px 0', display: 'flex', alignItems: 'center', gap: 8,
        opacity: 0.5, minHeight: 44, cursor: clickable ? 'pointer' : undefined,
        color: active ? 'var(--accent)' : 'inherit',
      }}
    >
      <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>
        <AgentIcon workerType={w.workerType} windowType={w.windowType} size={16} />
      </span>
      <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
        </div>
        {subtitle != null && (
          <div style={{
            fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
          }}>
            {subtitle}
          </div>
        )}
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 5 }}>
          {isRespawning && <Spinner />}
          {isRespawning ? t('windowPaneTree.respawning') : t('windowPaneTree.offline')}
        </div>
      </div>
      {extra}
    </div>
  );
}

function WindowRow({ w, sessionData, isActive, expandedWindows, onToggle, onUnzoom, onPaneClick, onContextMenu, onLongPress, extra, activityClassName, isRespawning, renderTaskBadge, renderSubtitle, renderTitle }: WindowRowProps) {
  const { t } = useTranslation('common');
  const { isFocusedWindow, isFocusedPane } = useGlobalFocus();
  const bindLongPress = useLongPress();
  const sessions = sessionData[w.serverName] || [];
  const parts = w.tmuxTarget.split(':');
  const sessionName = parts[0];
  const winPart = parts[1]?.split('.')[0] ?? null;
  const session = sessions.find((s) => s.name === sessionName);
  const hasLongPress = !!(onContextMenu || onLongPress);
  const offlineActive = isActive?.(w.serverName, w.tmuxTarget, 'window') ?? false;

  if (!session) {
    return <OfflineRow w={w} active={offlineActive} onPaneClick={onPaneClick} onContextMenu={onContextMenu} onLongPress={onLongPress} extra={extra} isRespawning={isRespawning} renderTaskBadge={renderTaskBadge} renderSubtitle={renderSubtitle} renderTitle={renderTitle} />;
  }

  let matchedWindows = winPart != null
    ? session.windows.filter((sw) => {
        const idx = parseInt(winPart, 10);
        return Number.isNaN(idx) ? sw.name === winPart : sw.index === idx;
      })
    : session.windows;

  if (matchedWindows.length > 1 && winPart != null && Number.isNaN(parseInt(winPart, 10))) {
    matchedWindows = [matchedWindows[0]];
  }

  if (matchedWindows.length === 0 && w.label) {
    matchedWindows = session.windows.filter((sw) => sw.name === w.label);
  }

  if (matchedWindows.length === 0) {
    return <OfflineRow w={w} active={offlineActive} onPaneClick={onPaneClick} onContextMenu={onContextMenu} onLongPress={onLongPress} extra={extra} isRespawning={isRespawning} renderTaskBadge={renderTaskBadge} renderSubtitle={renderSubtitle} renderTitle={renderTitle} />;
  }

  return (
    <>
      {matchedWindows.map((sw) => {
        const paneCount = sw.panes.length;
        const expandKey = `${w.id}-${sw.index}`;
        const isExpanded = expandedWindows.has(expandKey);
        const isUniqueName = session.windows.filter((w2) => w2.name === sw.name).length === 1;
        const windowId = isUniqueName ? sw.name : String(sw.index);

        if (paneCount <= 1) {
          const pane = sw.panes[0];
          if (!pane) return null;
          const target = `${sessionName}:${windowId}.${pane.index}`;
          const active = isActive?.(w.serverName, target, 'window') ?? false;
          const focused = !active && isFocusedWindow(w.serverName, target);
          const paneLabel = pane.title && pane.title !== pane.command ? pane.title : pane.command;
          const ctxExtra: ContextMenuExtra = { online: true, windowName: sw.name, paneTarget: target, paneTitle: paneLabel };
          const subtitle = renderSubtitle?.(w) ?? paneLabel;
          return (
            <div
              key={`${w.id}-${sw.index}-${pane.index}`}
              onClick={() => onPaneClick(w.serverName, target, w)}
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, w, ctxExtra) : undefined}
              {...(onLongPress ? bindLongPress((x, y) => onLongPress(x, y, w, ctxExtra)) : {})}
              className={`row-hover${active ? ' row-selected' : focused ? ' row-selected' : ''}${activityClassName ? ` ${activityClassName}` : ''}`}
              style={{
                ...(hasLongPress ? longPressStyle : {}),
                padding: '6px 12px', fontSize: 'var(--font-md)', cursor: 'pointer', borderRadius: 'var(--radius-sm)', margin: '1px 0',
                display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
                color: active ? 'var(--accent)' : 'inherit',
              }}
            >
              <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>
                <AgentIcon workerType={w.workerType} windowType={w.windowType} size={16} />
              </span>
              <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {renderTitle?.(w) ?? (w.label || sw.name)}
                  </span>
                  {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
                </div>
                <div style={{
                  fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
                }}>
                  {subtitle}
                </div>
              </div>
              {extra}
            </div>
          );
        }

        const windowLabel = renderTitle?.(w) ?? (w.label || sw.name);
        const windowHasActive = sw.panes.some((pane) => {
          const target = `${sessionName}:${windowId}.${pane.index}`;
          return isActive?.(w.serverName, target, 'window') ?? false;
        });
        const windowBaseTarget = `${sessionName}:${windowId}`;
        const windowHasFocus = !windowHasActive && isFocusedWindow(w.serverName, windowBaseTarget);
        const windowCtxExtra: ContextMenuExtra = { online: true, windowName: sw.name };
        const parentSubtitle = renderSubtitle?.(w) ?? null;

        return (
          <div key={`${w.id}-${sw.index}`}>
            <div
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, w, windowCtxExtra) : undefined}
              {...(onLongPress ? bindLongPress((x, y) => onLongPress(x, y, w, windowCtxExtra)) : {})}
              className={[(windowHasActive || windowHasFocus) ? 'row-selected' : null, activityClassName].filter(Boolean).join(' ') || undefined}
              style={{
                ...(hasLongPress ? longPressStyle : {}),
                padding: '6px 12px', fontSize: 'var(--font-md)', borderRadius: 'var(--radius-sm)', margin: '1px 0',
                display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
                color: windowHasActive ? 'var(--accent)' : 'inherit',
              }}
            >
              <span
                onClick={() => onToggle(expandKey)}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(expandKey); } }}
                className="icon-btn"
                style={{
                  color: 'var(--text-dim)', width: 16,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                }}
              ><Icon name="chevron-right" size={14} rotate={isExpanded ? 90 : 0} /></span>
              <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>
                <AgentIcon workerType={w.workerType} windowType={w.windowType} size={16} />
              </span>
              <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    onClick={() => onToggle(expandKey)}
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >{windowLabel}</span>
                  {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
                </div>
                {parentSubtitle != null && (
                  <div style={{
                    fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
                  }}>
                    {parentSubtitle}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onUnzoom(w.serverName, sessionName, windowId); }}
                title={t('windowPaneTree.showAllPanes')}
                aria-label={t('windowPaneTree.showAllPanesLabel')}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-dim)',
                  cursor: 'pointer', padding: '2px 3px', borderRadius: 'var(--radius-sm)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
                  <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" />
                  <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" />
                  <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" />
                  <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              </button>
              <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 'var(--radius-md)' }}>{paneCount}</span>
              {extra}
            </div>

            {isExpanded && sw.panes.map((pane) => {
              const target = `${sessionName}:${windowId}.${pane.index}`;
              const active = isActive?.(w.serverName, target, 'pane') ?? false;
              const focused = !active && isFocusedPane(w.serverName, target);
              const paneLabel = pane.title && pane.title !== pane.command ? pane.title : pane.command;
              const paneCtxExtra: ContextMenuExtra = { online: true, windowName: sw.name, paneTarget: target, paneTitle: paneLabel };
              return (
                <div
                  key={`${w.id}-${sw.index}-${pane.index}`}
                  onClick={() => onPaneClick(w.serverName, target, w)}
                  onContextMenu={onContextMenu ? (e) => onContextMenu(e, w, paneCtxExtra) : undefined}
                  {...(onLongPress ? bindLongPress((x, y) => onLongPress(x, y, w, paneCtxExtra)) : {})}
                  className={`row-hover${(active || focused) ? ' row-selected' : ''}`}
                  style={{
                    ...(hasLongPress ? longPressStyle : {}),
                    padding: '6px 12px 6px 44px', fontSize: 'var(--font-md)', cursor: 'pointer', borderRadius: 'var(--radius-sm)', margin: '1px 0',
                    display: 'flex', alignItems: 'center', gap: 8, minHeight: 32,
                    color: active ? 'var(--accent)' : 'inherit',
                  }}
                >
                  <span style={{ fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace", fontSize: 'var(--font-sm)' }}>
                    <span style={{ color: 'var(--text-dim)', marginRight: 6, fontSize: 'var(--font-xs)' }}>%{pane.index}</span>
                    {paneLabel}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
