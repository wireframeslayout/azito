import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui';
import { api } from '../../../api/client';
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
}

export default function BrowserSection({
  browsers,
  errors,
  activeTabId,
  tabs,
  closeTab,
  openBrowser,
  onRefresh,
}: BrowserSectionProps) {
  const { t } = useTranslation('workspace');
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());

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
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openBrowser(b.serverName, b.groupId);
              }
            }}
            style={{
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
              <div
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--text)',
                }}
              >
                {displayUrl}
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
                {t('objects.browserPages', { count: b.pageCount })} · {b.serverName}
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
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 'var(--radius-sm)',
            margin: '1px 0',
            fontSize: 'var(--font-sm)',
            color: 'var(--text-dim)',
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {t('objects.browserError')}
            <span style={{ fontSize: 'var(--font-xs)', marginLeft: 4 }}>({serverName})</span>
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="icon-btn"
            title={message}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              cursor: 'pointer',
              padding: '2px 6px',
              fontSize: 'var(--font-xs)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {t('objects.retry')}
          </button>
        </div>
      ))}
    </div>
  );
}
