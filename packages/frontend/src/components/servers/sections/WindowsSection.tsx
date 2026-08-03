import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { Server, Session, TmuxWindow } from '../../../hooks/useServerManagement';
import { useIsMobile } from '../../../hooks/useIsMobile';
import WindowTreePopover from '../WindowTreePopover';
import { TerminalContainer } from '../../TerminalContainer';
import { EmptyState } from '../../ui';
import { Icon } from '../../ui/Icon';

interface WindowsSectionProps {
  server: Server;
  sessions: Session[];
  refresh: () => void;
}

export default function WindowsSection({ server, sessions, refresh }: WindowsSectionProps) {
  const { t } = useTranslation('servers');
  const isMobile = useIsMobile();
  const [showTree, setShowTree] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  const firstTarget = useMemo(() => {
    for (const sess of sessions) {
      for (const win of sess.windows) {
        return `${sess.name}:${win.name ?? win.index}`;
      }
    }
    return null;
  }, [sessions]);

  const activeTarget = selectedTarget ?? firstTarget;

  const handleSelect = useCallback((target: string) => {
    setSelectedTarget(target);
    setShowTree(false);
  }, []);

  const handleCreateSession = useCallback(async () => {
    const name = prompt('New session name:');
    if (!name) return;
    await api(`/servers/${encodeURIComponent(server.name)}/sessions`, {
      method: 'POST', body: JSON.stringify({ name }),
    });
    refresh();
  }, [server.name, refresh]);

  const handleAddWindow = useCallback(async (sessionName: string) => {
    await api(`/servers/${encodeURIComponent(server.name)}/sessions/${sessionName}/windows`, { method: 'POST' });
    refresh();
  }, [server.name, refresh]);

  const handleSplitPane = useCallback(async (sessionName: string, windowName: string, direction: string) => {
    await api(
      `/servers/${encodeURIComponent(server.name)}/sessions/${sessionName}/windows/${encodeURIComponent(windowName)}/panes`,
      { method: 'POST', body: JSON.stringify({ direction }) },
    );
    refresh();
  }, [server.name, refresh]);

  if (sessions.length === 0) {
    return (
      <div>
        <EmptyState title={t('windows.noSessions')} />
        <div style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
          <button
            onClick={handleCreateSession}
            style={{
              background: 'var(--accent)', color: '#fff', border: 'none', // lint-allow: hex - white text on solid accent fill; no on-color token yet
              borderRadius: 'var(--radius-md)', padding: '8px 20px',
              fontSize: 'var(--font-sm)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Icon name="plus" size={16} /> {t('windows.createSession')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--font-xs)',
      }}>
        <button
          onClick={() => setShowTree(!showTree)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg-card)',
            border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 12px',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--font-xs)',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          {activeTarget ?? 'Select window'}
          <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-dim)' }}>
            <Icon name="chevron-down" size={14} rotate={showTree ? 180 : 0} />
          </span>
        </button>
        <div style={{ flex: 1 }} />
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {activeTarget ? (
          <TerminalContainer
            key={`${server.name}:${activeTarget}`}
            serverName={server.name}
            target={activeTarget}
            sessions={sessions}
            onWindowChanged={refresh}
          />
        ) : (
          <div style={{ color: 'var(--text-dim)', padding: '14px 16px', fontSize: 'var(--font-xs)' }}>{t('windows.noWindowSelected')}</div>
        )}
      </div>

      {showTree && (
        <WindowTreePopover
          sessions={sessions}
          serverName={server.name}
          selectedTarget={activeTarget}
          onSelect={handleSelect}
          onClose={() => setShowTree(false)}
          onCreateSession={handleCreateSession}
          onAddWindow={handleAddWindow}
          onSplitPane={handleSplitPane}
          isMobile={isMobile}
        />
      )}
    </div>
  );
}
