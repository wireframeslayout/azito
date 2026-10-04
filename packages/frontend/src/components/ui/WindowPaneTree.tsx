import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { api } from '../../api/client';
import { AgentIcon } from './AgentIcons';
import { WindowIdChip } from './WindowIdChip';
import { PaneStateChip, DIMMED_PANE_OPACITY } from './PaneStateChip';
import { Chip } from './Chip';
import { isPaneLive } from '../../lib/paneState';
import { resolveWindowDisplay } from '../../lib/windowDisplay';
import { canActOnMux, planWindowRow } from '../../lib/windowRowPlan';
import { EmptyWindowActions } from '../terminal/EmptyWindowActions';
import { useGlobalFocus } from '../../hooks/useGlobalFocus';
import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import type { Session, TmuxWindow, Window } from '../../pages/workspace/types';
import type { MuxRef } from '@azito/shared';

export type WindowItem = Pick<Window, 'id' | 'serverName' | 'tmuxTarget' | 'label' | 'taskId'> & { windowType?: string; workerType?: string; isPrimary?: boolean; sleeping?: boolean; muxRef?: MuxRef };

export type EmptyWindowOutcome = Parameters<React.ComponentProps<typeof EmptyWindowActions>['onChanged']>[0];

/** `stale`: the window's mux cannot be listed now, so mux actions in the menu are disabled. */
type ContextMenuExtra = { online: boolean; stale?: boolean; windowName?: string; paneTarget?: string; paneTitle?: string };

/** A window of a session kept from an earlier listing (its mux cannot be listed now): marked like an offline row. */
function StaleChip() {
  const { t } = useTranslation('servers');
  return <Chip>{t('status.offline')}</Chip>;
}

export interface WindowPaneTreeProps {
  windows: WindowItem[];
  sessionData: Record<string, Session[]>;
  isActive?: (serverName: string, target: string, level: 'window' | 'pane', windowId?: number) => boolean;
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
  /**
   * 指定すると、ペインのない窓（misao）の行に［ペインを開く］［窓を削除］を出し、完了時に呼ぶ。
   * 呼び出し元は窓一覧の再取得と（削除時は）その窓のタブを閉じる。未指定なら行のクリック（端末の案内）だけにする
   */
  onWindowsChanged?: (outcome: EmptyWindowOutcome, w: WindowItem) => void;
}

export function WindowPaneTree({ windows, sessionData, isActive, onPaneClick, onContextMenu, onLongPress, extra, activityClassName, respawningWindowIds, renderTaskBadge, renderSubtitle, renderTitle, onWindowsChanged }: WindowPaneTreeProps) {
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

  const handleUnzoom = useCallback(async (serverName: string, sessionName: string, windowName: string, windowId?: number, ref?: string) => {
    try {
      if (windowId != null) {
        await api(`/windows/${windowId}/panes/1/unzoom`, { method: 'POST' });
      } else if (ref) {
        await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/panes/1/unzoom`, { method: 'POST' });
      } else {
        const target = `${sessionName}:${windowName}`;
        await api(`/servers/${serverName}/panes/${encodeURIComponent(target)}/unzoom`, { method: 'POST' });
      }
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
          onWindowsChanged={onWindowsChanged}
        />
      ))}
    </div>
  );
}

interface WindowRowProps {
  w: WindowItem;
  sessionData: Record<string, Session[]>;
  isActive?: (serverName: string, target: string, level: 'window' | 'pane', windowId?: number) => boolean;
  expandedWindows: Set<string>;
  onToggle: (key: string) => void;
  onUnzoom: (serverName: string, sessionName: string, windowName: string, windowId?: number, ref?: string) => void;
  onPaneClick: (serverName: string, target: string, w: WindowItem) => void;
  onContextMenu?: (e: React.MouseEvent, w: WindowItem, extra?: ContextMenuExtra) => void;
  onLongPress?: (x: number, y: number, w: WindowItem, extra?: ContextMenuExtra) => void;
  extra?: React.ReactNode;
  activityClassName?: string;
  isRespawning?: boolean;
  renderTaskBadge?: (w: WindowItem, taskId: number) => React.ReactNode;
  renderSubtitle?: (w: WindowItem) => React.ReactNode | null | undefined;
  renderTitle?: (w: WindowItem) => React.ReactNode | null | undefined;
  onWindowsChanged?: WindowPaneTreeProps['onWindowsChanged'];
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
  const display = resolveWindowDisplay({ windowId: w.id, label: w.label, workerType: w.workerType, windowType: w.windowType, tmuxTarget: w.tmuxTarget });
  const title = renderTitle?.(w) ?? display.title;
  const showIdChip = renderTitle?.(w) != null ? w.id != null : !!display.idLabel;
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
          {showIdChip && <WindowIdChip id={w.id!} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
        </div>
        {subtitle != null && (typeof subtitle !== 'string' || subtitle !== title) && (
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

function SleepingRow({ w, active, onPaneClick, onContextMenu, onLongPress, extra, renderTaskBadge, renderSubtitle, renderTitle }: {
  w: WindowItem;
  active?: boolean;
  onPaneClick?: WindowRowProps['onPaneClick'];
  onContextMenu?: WindowRowProps['onContextMenu'];
  onLongPress?: WindowRowProps['onLongPress'];
  extra?: React.ReactNode;
  renderTaskBadge?: (w: WindowItem, taskId: number) => React.ReactNode;
  renderSubtitle?: (w: WindowItem) => React.ReactNode | null | undefined;
  renderTitle?: (w: WindowItem) => React.ReactNode | null | undefined;
}) {
  const { t } = useTranslation('common');
  const bindLongPress = useLongPress();
  const clickable = !!onPaneClick;
  const subtitle = renderSubtitle?.(w);
  const display = resolveWindowDisplay({ windowId: w.id, label: w.label, workerType: w.workerType, windowType: w.windowType, tmuxTarget: w.tmuxTarget });
  const title = renderTitle?.(w) ?? display.title;
  const showIdChip = renderTitle?.(w) != null ? w.id != null : !!display.idLabel;
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
          {showIdChip && <WindowIdChip id={w.id!} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
        </div>
        {subtitle != null && (typeof subtitle !== 'string' || subtitle !== title) && (
          <div style={{
            fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
          }}>
            {subtitle}
          </div>
        )}
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 5 }}>
          {t('windowPaneTree.sleeping')}
        </div>
      </div>
      <Icon name="moon" size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
      {extra}
    </div>
  );
}

function EmptyWindowRow({ w, sessionWindow, title, plainTitle, showIdChip, active, focused, onPaneClick, onContextMenu, onLongPress, extra, activityClassName, renderTaskBadge, onWindowsChanged, stale }: {
  w: WindowItem;
  sessionWindow: TmuxWindow;
  title: React.ReactNode;
  /** 削除確認に出す窓名（renderTitle で差し替えられていない表示名） */
  plainTitle: string;
  showIdChip: boolean;
  active: boolean;
  focused: boolean;
  onPaneClick: () => void;
  onContextMenu?: WindowRowProps['onContextMenu'];
  onLongPress?: WindowRowProps['onLongPress'];
  extra?: React.ReactNode;
  activityClassName?: string;
  renderTaskBadge?: (w: WindowItem, taskId: number) => React.ReactNode;
  onWindowsChanged?: WindowPaneTreeProps['onWindowsChanged'];
  stale: boolean;
}) {
  const { t } = useTranslation('servers');
  const bindLongPress = useLongPress();
  const hasLongPress = !!(onContextMenu || onLongPress);
  const ctxExtra: ContextMenuExtra = { online: true, stale, windowName: sessionWindow.name };
  return (
    <div>
      <div
        onClick={onPaneClick}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, w, ctxExtra) : undefined}
        {...(onLongPress ? bindLongPress((x, y) => onLongPress(x, y, w, ctxExtra)) : {})}
        className={`row-hover${(active || focused) ? ' row-selected' : ''}${activityClassName ? ` ${activityClassName}` : ''}`}
        style={{
          ...(hasLongPress ? longPressStyle : {}),
          position: 'relative',
          padding: '6px 12px', fontSize: 'var(--font-md)', cursor: 'pointer', borderRadius: 'var(--radius-sm)', margin: '1px 0',
          display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
          color: active ? 'var(--accent)' : 'inherit',
        }}
      >
        {/* Keyboard / assistive-tech target for the row. Siblings (task badge, extra) stay separate interactive
            elements; a click anywhere on the row, this button included, reaches the row's onClick. */}
        <button type="button" className="window-row-hit" aria-label={plainTitle} />
        <span style={{ position: 'relative', width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>
          <AgentIcon workerType={w.workerType} windowType={w.windowType} size={16} />
        </span>
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {showIdChip && <WindowIdChip id={w.id!} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: stale ? DIMMED_PANE_OPACITY : undefined }}>{title}</span>
            {stale && <StaleChip />}
            {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
          </div>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 1 }}>
            {t('windows.noPanes')}
          </div>
        </div>
        {extra != null && <span style={{ position: 'relative', display: 'flex' }}>{extra}</span>}
      </div>
      {onWindowsChanged && (
        <EmptyWindowActions
          serverName={w.serverName}
          windowId={w.id}
          muxRef={sessionWindow.ref}
          windowLabel={plainTitle}
          disabled={stale}
          onChanged={(outcome) => onWindowsChanged(outcome, w)}
        />
      )}
    </div>
  );
}

function WindowRow({ w, sessionData, isActive, expandedWindows, onToggle, onUnzoom, onPaneClick, onContextMenu, onLongPress, extra, activityClassName, isRespawning, renderTaskBadge, renderSubtitle, renderTitle, onWindowsChanged }: WindowRowProps) {
  const { t } = useTranslation('common');
  const { isFocusedWindow, isFocusedPane } = useGlobalFocus();
  const bindLongPress = useLongPress();
  const hasLongPress = !!(onContextMenu || onLongPress);
  const offlineActive = isActive?.(w.serverName, w.tmuxTarget, 'window', w.id) ?? false;
  const plan = planWindowRow(w, sessionData[w.serverName] || []);

  if (plan.kind === 'sleeping') {
    return <SleepingRow w={w} active={offlineActive} onPaneClick={onPaneClick} onContextMenu={onContextMenu} onLongPress={onLongPress} extra={extra} renderTaskBadge={renderTaskBadge} renderSubtitle={renderSubtitle} renderTitle={renderTitle} />;
  }

  if (plan.kind === 'offline') {
    return <OfflineRow w={w} active={offlineActive} onPaneClick={onPaneClick} onContextMenu={onContextMenu} onLongPress={onLongPress} extra={extra} isRespawning={isRespawning} renderTaskBadge={renderTaskBadge} renderSubtitle={renderSubtitle} renderTitle={renderTitle} />;
  }

  // 行のターゲットは DB の値（w.tmuxTarget）にペイン番号を付けたもの。セッション一覧の窓名から組み立てると、
  // misao の表示名や改名後の窓で DB の値と食い違い、タブ ID・選択強調が外れる。
  const { session, window: sw, panes, baseTarget, windowSpec } = plan;
  const sessionName = session.name;
  const paneCount = panes.length;
  const expandKey = `${w.id}-${sw.index}`;
  const isExpanded = expandedWindows.has(expandKey);

  // resolveWindowDisplay を先に計算し、idChip の重複を防ぐ
  const winDisplay = resolveWindowDisplay({ windowId: w.id, paneTitle: sw.panes[0]?.title, paneCommand: sw.panes[0]?.command, label: w.label, workerType: w.workerType, windowType: w.windowType, tmuxTarget: w.tmuxTarget });
  const winTitle = renderTitle?.(w) ?? winDisplay.title;
  const winShowIdChip = renderTitle?.(w) != null ? w.id != null : !!winDisplay.idLabel;

  if (paneCount === 0) {
    // misao は最後のペインが閉じても窓を残す。tmux ではこの状態にならない
    const target = plan.clickTarget;
    const active = isActive?.(w.serverName, target, 'window', w.id) ?? false;
    const focused = !active && isFocusedWindow(w.serverName, target, w.id);
    return (
      <EmptyWindowRow
        w={w}
        sessionWindow={sw}
        title={winTitle}
        plainTitle={winDisplay.title}
        showIdChip={winShowIdChip}
        active={active}
        focused={focused}
        onPaneClick={() => onPaneClick(w.serverName, target, w)}
        onContextMenu={onContextMenu}
        onLongPress={onLongPress}
        extra={extra}
        activityClassName={activityClassName}
        renderTaskBadge={renderTaskBadge}
        onWindowsChanged={onWindowsChanged}
        stale={plan.stale}
      />
    );
  }

  if (paneCount === 1) {
    const pane = sw.panes[0];
    const target = panes[0].target;
    const active = isActive?.(w.serverName, target, 'window', w.id) ?? false;
    const focused = !active && isFocusedWindow(w.serverName, target, w.id);
    const paneLabel = pane.title && pane.title !== pane.command ? pane.title : pane.command;
    const ctxExtra: ContextMenuExtra = { online: true, stale: plan.stale, windowName: sw.name, paneTarget: panes[0].menuPaneTarget, paneTitle: paneLabel };
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
            {winShowIdChip && <WindowIdChip id={w.id!} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: isPaneLive(pane) && !plan.stale ? undefined : DIMMED_PANE_OPACITY }}>
              {winTitle}
            </span>
            {plan.stale ? <StaleChip /> : <PaneStateChip pane={pane} />}
            {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
          </div>
          {subtitle != null && (typeof subtitle !== 'string' || subtitle !== winTitle) && (
            <div style={{
              fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
            }}>
              {subtitle}
            </div>
          )}
        </div>
        {extra}
      </div>
    );
  }

  const windowLabel = winTitle;
  const windowHasActive = panes.some((pane) => isActive?.(w.serverName, pane.target, 'window', w.id) ?? false);
  const windowHasFocus = !windowHasActive && isFocusedWindow(w.serverName, baseTarget, w.id);
  const windowCtxExtra: ContextMenuExtra = { online: true, stale: plan.stale, windowName: sw.name };
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
            {winShowIdChip && <WindowIdChip id={w.id!} />}
            <span
              onClick={() => onToggle(expandKey)}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', opacity: plan.stale ? DIMMED_PANE_OPACITY : undefined }}
            >{windowLabel}</span>
            {plan.stale && <StaleChip />}
            {w.taskId != null && (renderTaskBadge ? renderTaskBadge(w, w.taskId) : <TaskIdBadge taskId={w.taskId} />)}
          </div>
          {parentSubtitle != null && (typeof parentSubtitle !== 'string' || parentSubtitle !== windowLabel) && (
            <div style={{
              fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
            }}>
              {parentSubtitle}
            </div>
          )}
        </div>
        <button
          disabled={!canActOnMux(plan)}
          onClick={(e) => { e.stopPropagation(); onUnzoom(w.serverName, sessionName, windowSpec, sw.windowId ?? undefined, sw.ref); }}
          title={t('windowPaneTree.showAllPanes')}
          aria-label={t('windowPaneTree.showAllPanesLabel')}
          style={{
            background: 'none', border: 'none', color: 'var(--text-dim)',
            cursor: canActOnMux(plan) ? 'pointer' : 'not-allowed', opacity: canActOnMux(plan) ? undefined : DIMMED_PANE_OPACITY,
            padding: '2px 3px', borderRadius: 'var(--radius-sm)',
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
        const planned = panes.find((p) => p.index === pane.index)!;
        const target = planned.target;
        const active = isActive?.(w.serverName, target, 'pane', w.id) ?? false;
        const focused = !active && isFocusedPane(w.serverName, target);
        const paneLabel = pane.title && pane.title !== pane.command ? pane.title : pane.command;
        const paneCtxExtra: ContextMenuExtra = { online: true, stale: plan.stale, windowName: sw.name, paneTarget: planned.menuPaneTarget, paneTitle: paneLabel };
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
            <span style={{ fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace", fontSize: 'var(--font-sm)', opacity: isPaneLive(pane) ? undefined : DIMMED_PANE_OPACITY }}>
              <span style={{ color: 'var(--text-dim)', marginRight: 6, fontSize: 'var(--font-xs)' }}>%{pane.index}</span>
              {paneLabel}
            </span>
            <PaneStateChip pane={pane} />
          </div>
        );
      })}
    </div>
  );
}
