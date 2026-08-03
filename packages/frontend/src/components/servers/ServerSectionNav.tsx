import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Server } from '../../hooks/useServerManagement';
import { SERVER_SECTIONS, serverSectionPath } from './serverSections';
import type { ServerSectionId } from './serverSections';
import { paths } from '../../paths';

interface ServerSectionNavProps {
  servers: Server[];
  currentServerName: string;
  activeSection: ServerSectionId;
}

export default function ServerSectionNav({ servers, currentServerName, activeSection }: ServerSectionNavProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('servers');

  return (
    <nav style={{
      width: 230,
      borderRight: '1px solid var(--border)',
      padding: '12px 10px',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <select
        value={currentServerName}
        onChange={(e) => navigate(paths.server(e.target.value, activeSection))}
        aria-label={t('detail.serverSelect')}
        style={{
          width: '100%',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: '9px 12px',
          fontSize: 'var(--font-sm)',
          fontWeight: 700,
          color: 'var(--text)',
          cursor: 'pointer',
          marginBottom: 10,
          appearance: 'auto',
        }}
      >
        {servers.map((s) => (
          <option key={s.name} value={s.name}>{s.name}</option>
        ))}
      </select>

      {SERVER_SECTIONS.map((sec) => {
        const isActive = sec.id === activeSection;
        return (
          <button
            key={sec.id}
            onClick={() => navigate(serverSectionPath(currentServerName, sec.id))}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 'var(--font-sm)',
              color: sec.danger ? 'var(--danger)' : isActive ? 'var(--text)' : 'var(--text-dim)',
              padding: '7px 10px',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              background: isActive ? 'var(--selected-bg)' : 'transparent',
              border: 'none',
              width: '100%',
              textAlign: 'left',
              transition: 'background 0.15s ease, color 0.15s ease',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'var(--bg-hover)';
                if (!sec.danger) e.currentTarget.style.color = 'var(--text)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'transparent';
                if (!sec.danger) e.currentTarget.style.color = 'var(--text-dim)';
              }
            }}
          >
            <span style={{ width: 20, textAlign: 'center', flexShrink: 0 }}>{sec.icon}</span>
            {t(sec.labelKey)}
          </button>
        );
      })}
    </nav>
  );
}
