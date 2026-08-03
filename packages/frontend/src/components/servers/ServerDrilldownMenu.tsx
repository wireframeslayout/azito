import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Server } from '../../hooks/useServerManagement';
import { SERVER_SECTIONS, serverSectionPath, getOverviewSummary, getSetupSummary, getWindowsSummary } from './serverSections';
import type { InstallStatusResponse, ServerStatus, SectionSummary } from './serverSections';
import type { Session } from '../../hooks/useServerManagement';
import { paths } from '../../paths';

interface ServerDrilldownMenuProps {
  servers: Server[];
  currentServerName: string;
  status: ServerStatus | null;
  installStatus: InstallStatusResponse | null;
  sessions: Session[];
}

export default function ServerDrilldownMenu({
  servers,
  currentServerName,
  status,
  installStatus,
  sessions,
}: ServerDrilldownMenuProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('servers');

  const windowCount = sessions.reduce((sum, s) => sum + s.windows.length, 0);

  const summaries: Record<string, SectionSummary> = {
    overview: getOverviewSummary(status),
    setup: getSetupSummary(installStatus),
    windows: getWindowsSummary(sessions.length, windowCount),
    danger: { text: '', tone: 'dim' },
  };

  return (
    <div style={{ padding: '8px 12px' }}>
      <select
        value={currentServerName}
        onChange={(e) => navigate(paths.server(e.target.value))}
        aria-label={t('detail.serverSelect')}
        style={{
          width: '100%',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '10px 13px',
          fontSize: 'var(--font-md)',
          fontWeight: 700,
          color: 'var(--text)',
          cursor: 'pointer',
          margin: '6px 0 12px',
          appearance: 'auto',
        }}
      >
        {servers.map((s) => (
          <option key={s.name} value={s.name}>{s.name}</option>
        ))}
      </select>

      {SERVER_SECTIONS.map((sec) => {
        const summary = summaries[sec.id];
        return (
          <button
            key={sec.id}
            onClick={() => navigate(serverSectionPath(currentServerName, sec.id))}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              width: '100%',
              background: 'var(--bg-card)',
              border: `1px solid ${sec.danger ? 'color-mix(in srgb, var(--danger) 30%, transparent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-lg)',
              padding: '12px 13px',
              marginBottom: 8,
              fontSize: 'var(--font-sm)',
              color: sec.danger ? 'var(--danger)' : 'var(--text)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-card)'; }}
          >
            <span style={{ width: 20, textAlign: 'center', color: 'var(--text-dim)', flexShrink: 0 }}>{sec.icon}</span>
            <span style={{ flex: 1 }}>{t(sec.labelKey)}</span>
            {summary.text && (
              <span style={{
                marginLeft: 'auto',
                fontSize: 'var(--font-xs)',
                color: summary.tone === 'green' ? 'var(--success)' : summary.tone === 'orange' ? 'var(--warning)' : 'var(--text-dim)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                {summary.tone === 'green' && (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
                )}
                {t(summary.text, summary.textParams)}
              </span>
            )}
            <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>›</span>
          </button>
        );
      })}
    </div>
  );
}
