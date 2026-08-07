import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui';
import { api } from '../../../api/client';
import { useLongPress, longPressStyle } from '../../../hooks/useLongPress';
import type { BrowserObject } from '../../../lib/workspaceObjects';
import type { PersistedTab } from '../../../hooks/useTabPersistence';

interface BrowserSectionProps {
  browsers: BrowserObject[];
  errors: Record<string, string>;
  activeTabId: string | null;
  tabs: PersistedTab[];
  closeTab: (tabId: string) => void;
  openBrowser: (serverName: string, groupId?: string) => void;
  onRefresh: () => void;
  onContextMenu?: (e: React.MouseEvent, b: BrowserObject) => void;
  onLongPress?: (x: number, y: number, b: BrowserObject) => void;
}

export default function BrowserSection({
  browsers,
  errors,
  activeTabId,
  tabs,
  closeTab,
  openBrowser,
  onRefresh,
  onContextMenu,
  onLongPress,
}: BrowserSectionProps) {
  const { t } = useTranslation('workspace');
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const bindLongPress = useLongPress();
  const hasLongPress = !!(onContextMenu || onLongPress);

  const handleClose = useCallback(
    async (b: BrowserObject, e: React.MouseEvent) => {
      e.stopPropagation();
      const tabId = `browser:${b.serverName}/${b.groupId}`;
      if (tabs.some((t) => t.id === tabId)) {
        // The workspace tab is open: route through its own close path, which
        // already tears down the server-side group (useTabPersistence's
        // closeTab -> closeBrowserGroup) and refreshes this list. Calling
        // /browser/close-group here too would tear the group down twice.
        closeTab(tabId);
        return;
      }
      setClosingIds((prev) => new Set(prev).add(b.groupId));
      try {
        await api('/browser/close-group', {
          method: 'POST',
          body: JSON.stringify({ server: b.serverName, group: b.groupId }),
        });
        onRefresh();
      } finally {
        setClosingIds((prev) => {
          const n = new Set(prev);
          n.delete(b.groupId);
          return n;
        });
      }
    },
    [tabs, closeTab, onRefresh],
  );

  const errorServers = Object.entries(errors).filter(
    ([serverName]) => !browsers.some((b) => b.serverName === serverName),
  );

  return (
    <div>
      {browsers.map((b) => {
        const isClosing = closingIds.has(b.groupId);
        const isActive = activeTabId === `browser:${b.serverName}/${b.groupId}`;
        const displayUrl = b.primaryUrl
          ? b.primaryUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
          : t('objects.browserBlankUrl');

        return (
          <div
            key={`${b.serverName}/${b.groupId}`}
            className={`row-hover${isActive ? ' row-selected' : ''}`}
            onClick={() => openBrowser(b.serverName, b.groupId)}
            onContextMenu={onContextMenu ? (e) => onContextMenu(e, b) : undefined}
            {...(onLongPress ? bindLongPress((x, y) => onLongPress(x, y, b)) : {})}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openBrowser(b.serverName, b.groupId);
              }
            }}
            style={{
              ...(hasLongPress ? longPressStyle : {}),
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 'var(--radius-sm)',
              margin: '1px 0',
              cursor: 'pointer',
              fontSize: 'var(--font-md)',
              minHeight: 32,
              background: isActive ? 'var(--selected-bg-strong)' : undefined,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, flexShrink: 0 }}>
              <Icon name="browser" size={16} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--text)',
                  }}
                >
                  {displayUrl}
                </span>
                <span
                  aria-label={t('objects.browserPages', { count: b.pageCount })}
                  style={{
                    fontSize: 'var(--font-2xs)',
                    color: 'var(--text-dim)',
                    background: 'var(--bg)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '1px 5px',
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {b.pageCount}
                </span>
              </div>
              <div
                style={{
                  fontSize: 'var(--font-xs)',
                  color: 'var(--text-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {b.serverName} · {b.groupId}
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => handleClose(b, e)}
              disabled={isClosing}
              aria-label={t('objects.closeBrowserGroup')}
              className="icon-btn"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-dim)',
                cursor: isClosing ? 'not-allowed' : 'pointer',
                padding: '3px 4px',
                borderRadius: 'var(--radius-sm)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: isClosing ? 0.5 : 1,
                flexShrink: 0,
              }}
            >
              {isClosing ? <Spinner /> : <Icon name="close" size={14} />}
            </button>
          </div>
        );
      })}

      {errorServers.map(([serverName, message]) => (
        <div
          key={`error-${serverName}`}
          role="status"
          style={{
            margin: '2px 4px 6px',
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            boxShadow: 'inset 2px 0 0 var(--danger)',
            fontSize: 'var(--font-xs)',
            color: 'var(--text)',
          }}
        >
          {t('objects.browserError')}
          {/* 実際のエラー内容（サーバー名 + 生のメッセージ）をそのまま出す。友好的な言い換えで隠さない */}
          <span style={{ display: 'block', color: 'var(--text-dim)', marginTop: 2 }}>{serverName}: {message}</span>
          <button
            type="button"
            onClick={onRefresh}
            style={{
              display: 'block',
              marginTop: 7,
              background: 'var(--bg-hover)',
              border: 'none',
              color: 'var(--text)',
              font: 'inherit',
              fontSize: 'var(--font-xs)',
              padding: '3px 9px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            {t('objects.retry')}
          </button>
        </div>
      ))}
    </div>
  );
}
