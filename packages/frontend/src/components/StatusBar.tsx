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

interface StatusBarProps {
  servers: ServerResourceEntry[];
}

interface RegistryItem {
  id: string;
  label: string;
  dot: DotLevel;
  renderDropdown: () => React.ReactNode;
}

export function StatusBar({ servers }: StatusBarProps) {
  const { t } = useTranslation('common');
  const { focusedTarget } = useWorkspaceTargets();
  const { status: updateStatus, startUpdate, checkNow } = useSystemUpdate();
  const { showToast } = useToast();
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, StatusBarItemRef>>(new Map());

  const focusedServer = useMemo(() => {
    if (!focusedTarget) return null;
    const idx = focusedTarget.indexOf('::');
    return idx > 0 ? focusedTarget.slice(0, idx) : null;
  }, [focusedTarget]);

  const contextLabel = useMemo(() => {
    if (!focusedTarget) return null;
    const idx = focusedTarget.indexOf('::');
    return idx > 0 ? focusedTarget.slice(idx + 2) : null;
  }, [focusedTarget]);

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
        renderDropdown: () => <ResourceDropdownContent serverName={hubServer.serverName} health={health} />,
      });
      seen.add(hubServer.serverName);
    }

    if (focusedServer && !seen.has(focusedServer)) {
      const entry = servers.find((s) => s.serverName === focusedServer);
      if (entry) {
        const health = getHealthLevel(entry.measurement);
        items.push({
          id: entry.serverName,
          label: entry.serverName,
          dot: health,
          renderDropdown: () => <ResourceDropdownContent serverName={entry.serverName} health={health} />,
        });
      }
    }

    return items;
  }, [servers, focusedServer, updateStatus, handleStartUpdate, checkNow]);

  const handleItemClick = useCallback((itemId: string) => {
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
        right: Math.max(8, Math.min(right, window.innerWidth - 360 - 8)),
      });
    }
    setOpenItemId(itemId);
  }, [openItemId]);

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
            onClick={() => handleItemClick(item.id)}
          />
        ))}
      </div>

      {openItem && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            zIndex: 300,
            width: 360,
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

