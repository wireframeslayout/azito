import { LookoutDrawer } from './lookout/LookoutDrawer';
import { useLookout } from '../hooks/useLookout';
import { useIsMobile } from '../hooks/useIsMobile';
import { useAgentActivity } from '../hooks/useAgentActivity';
import { useCrossProjectNavigation } from '../hooks/useCrossProjectNavigation';
import type { LookoutItem } from '../lib/lookoutSummary';
import { openLookoutItem } from '../lib/lookoutOpen';
import { useOpenGlobalSearch } from './search/GlobalSearch';
import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceTargets } from '../hooks/useWorkspaceTargets';
import { StatusBarItem } from './statusbar/StatusBarItem';
import type { StatusBarItemRef } from './statusbar/StatusBarItem';
import type { DotLevel } from './statusbar/HealthDot';
import { ResourceDropdownContent } from './statusbar/ResourceDropdown';
import { UpdateDropdown } from './system/UpdateDropdown';
import { getHealthLevel } from '../hooks/useServerResources';
import type { ServerResourceEntry } from '../hooks/useServerResources';
import { useSystemUpdate } from '../hooks/useSystemUpdate';
import { useToast } from '../hooks/useToast';
import { useActivityDiagnostics, DIAGNOSTICS_POLL_INTERVAL_MS } from '../hooks/useActivityDiagnostics';
import { activityDotState } from '../lib/activityDiagnostics';
import { ActivityDiagnosticsDropdown } from './activity/ActivityDiagnosticsDropdown';

const ACTIVITY_ITEM_ID = 'activity-diagnostics';
const DEFAULT_DROPDOWN_WIDTH = 360;
const ACTIVITY_DROPDOWN_WIDTH = 640;
/** 閉じている間はドット（稼働の有無・判定 Tier の別）にしか使わないので、粗く回す。 */
const DIAGNOSTICS_IDLE_POLL_INTERVAL_MS = 30_000;

interface StatusBarProps {
  servers: ServerResourceEntry[];
}

interface RegistryItem {
  id: string;
  label: string;
  dot: DotLevel;
  /** ドロップダウンの幅（既定 360px）。稼働検知は表を出すため広い器を使う。 */
  width?: number;
  renderDropdown: () => React.ReactNode;
}

export function StatusBar({ servers }: StatusBarProps) {
  const { t } = useTranslation('common');
  const { t: tl } = useTranslation('lookout');
  const lookout = useLookout();
  const isMobile = useIsMobile();
  const { snapshotStatus, retrySnapshot } = useAgentActivity();
  const { openTask, openTerminal } = useCrossProjectNavigation();
  const handleOpenLookoutItem = (item: LookoutItem) => {
    openLookoutItem(item, id => openTask(id), openTerminal);
    lookout.closeDrawer();
  };
  const { t: tn } = useTranslation('navigation');
  const openSearch = useOpenGlobalSearch();
  const { focusedTargetDisplay } = useWorkspaceTargets();
  const { status: updateStatus, startUpdate, checkNow } = useSystemUpdate();
  const { showToast } = useToast();
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, StatusBarItemRef>>(new Map());

  // 稼働検知診断は「ソースコード版」または「開発中バージョン」チャンネルでのみ出す（サーバー側
  // 判定 = UpdateStatusResponse.diagnosticsEnabled）。取得前は出さない（フェイルクローズ）。
  const diagnosticsEnabled = updateStatus?.diagnosticsEnabled === true;
  const diagnosticsOpen = openItemId === ACTIVITY_ITEM_ID;
  const { rows: diagnosticRows, error: diagnosticsError } = useActivityDiagnostics(
    diagnosticsEnabled,
    diagnosticsOpen ? DIAGNOSTICS_POLL_INTERVAL_MS : DIAGNOSTICS_IDLE_POLL_INTERVAL_MS,
  );

  const focusedServer = focusedTargetDisplay?.serverName ?? null;
  const contextLabel = focusedTargetDisplay?.label ?? null;

  const handleStartUpdate = useCallback(async () => {
    const res = await startUpdate();
    if (!res.started && res.error) showToast(res.error);
  }, [startUpdate, showToast]);

  const registry: RegistryItem[] = useMemo(() => {
    const items: RegistryItem[] = [];
    const seen = new Set<string>();

    if (updateStatus?.status === 'update-available') {
      items.push({
        id: 'system-update',
        label: updateStatus.commitsBehind > 0 ? t('statusbar.updateAvailableWithCount', { count: updateStatus.commitsBehind }) : t('statusbar.updateAvailable'),
        dot: 'update',
        renderDropdown: () => <UpdateDropdown onStartUpdate={handleStartUpdate} onCheckNow={checkNow} />,
      });
    }

    const hubServer = servers.find((s) => s.type === 'local');
    if (hubServer) {
      const health = getHealthLevel(hubServer.measurement);
      items.push({
        id: hubServer.serverName,
        label: 'Hub',
        dot: health,
        renderDropdown: () => <ResourceDropdownContent serverName={hubServer.serverName} health={health} unavailable={hubServer.unavailable} />,
      });
      seen.add(hubServer.serverName);
    }

    // 位置は Hub と「フォーカス中サーバー」の間（モック §2）。
    if (diagnosticsEnabled) {
      items.push({
        id: ACTIVITY_ITEM_ID,
        label: t('statusbar.activityDiagnostics'),
        dot: activityDotState(diagnosticRows),
        width: ACTIVITY_DROPDOWN_WIDTH,
        renderDropdown: () => (
          <ActivityDiagnosticsDropdown
            rows={diagnosticRows}
            error={diagnosticsError}
            onClose={() => setOpenItemId(null)}
          />
        ),
      });
    }

    if (focusedServer && !seen.has(focusedServer)) {
      const entry = servers.find((s) => s.serverName === focusedServer);
      if (entry) {
        const health = getHealthLevel(entry.measurement);
        items.push({
          id: entry.serverName,
          label: entry.serverName,
          dot: health,
          renderDropdown: () => <ResourceDropdownContent serverName={entry.serverName} health={health} unavailable={entry.unavailable} />,
        });
      }
    }

    return items;
  }, [servers, focusedServer, updateStatus, handleStartUpdate, checkNow, diagnosticsEnabled, diagnosticRows, diagnosticsError, t]);

  const handleItemClick = useCallback((itemId: string, width: number) => {
    if (lookout.open) lookout.closeDrawer();
    if (openItemId === itemId) {
      setOpenItemId(null);
      return;
    }
    const itemRef = itemRefs.current.get(itemId);
    const rect = itemRef?.getBoundingRect();
    if (rect) {
      const right = Math.max(8, window.innerWidth - rect.right);
      setDropdownStyle({
        bottom: window.innerHeight - rect.top + 4,
        right: Math.max(8, Math.min(right, window.innerWidth - width - 8)),
      });
    }
    setOpenItemId(itemId);
  }, [openItemId, lookout]);

  useEffect(() => {
    if (!openItemId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpenItemId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openItemId]);

  useEffect(() => {
    if (!openItemId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenItemId(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [openItemId]);

  const openItem = registry.find((r) => r.id === openItemId);

  return (
    <>
      <div
        ref={containerRef}
        className="status-bar-desktop"
        role="status"
        style={{
          height: 26,
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-card)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 12px',
          fontFamily: 'var(--mono)',
          fontSize: 'var(--font-xs)',
          color: 'var(--text-dim)',
          flexShrink: 0,
        }}
      >
        {contextLabel && (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ❯_ {contextLabel}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => openSearch()} className="row-hover" style={{ padding: '2px 10px', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)' }}>{tn('globalSearch.title')}</button>
        <StatusBarItem label={tl('title')} active={lookout.open} popup="dialog" badge={lookout.sections.counts.attention} badgeLabel={tl('attentionCount', { count: lookout.sections.counts.attention })} onClick={() => { setOpenItemId(null); if (lookout.open) lookout.closeDrawer(); else lookout.openDrawer(); }} />
        {registry.map((item) => (
          <StatusBarItem
            key={item.id}
            ref={(r) => {
              if (r) itemRefs.current.set(item.id, r);
              else itemRefs.current.delete(item.id);
            }}
            label={item.label}
            dot={item.dot}
            active={openItemId === item.id}
            onClick={() => handleItemClick(item.id, item.width ?? DEFAULT_DROPDOWN_WIDTH)}
          />
        ))}
      </div>

      <LookoutDrawer open={lookout.open && !isMobile} onClose={lookout.closeDrawer} sections={lookout.sections} snapshotStatus={snapshotStatus} onRetry={retrySnapshot} onOpenItem={handleOpenLookoutItem} />

      {openItem && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            zIndex: 300,
            width: openItem.width ?? DEFAULT_DROPDOWN_WIDTH,
            maxWidth: 'calc(100vw - 16px)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
            overflow: 'hidden',
            ...dropdownStyle,
          }}
        >
          {openItem.renderDropdown()}
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          .status-bar-desktop { display: none !important; }
        }
      `}</style>
    </>
  );
}

