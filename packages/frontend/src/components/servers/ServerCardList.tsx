import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { paths } from '../../paths';
import type { Server, ServerStatus } from '../../hooks/useServerManagement';
import { Chip } from '../ui';

interface ServerCardListProps {
  servers: Server[];
  statuses: Record<string, ServerStatus>;
}

export default function ServerCardList({ servers, statuses }: ServerCardListProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('servers');
  const hub = servers.find((s) => s.type === 'local');
  const remotes = servers.filter((s) => s.type !== 'local');

  return (
    <div style={{ padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {hub && <ServerCard server={hub} status={statuses[hub.name]} isHub onClick={() => navigate(paths.server(hub.name))} />}
      {remotes.map((srv) => (
        <ServerCard
          key={srv.name}
          server={srv}
          status={statuses[srv.name]}
          hubVersion={hub?.hubVersion ?? null}
          onClick={() => navigate(paths.server(srv.name))}
        />
      ))}
    </div>
  );
}

function ServerCard({
  server,
  status,
  isHub,
  hubVersion,
  onClick,
}: {
  server: Server;
  status: ServerStatus | undefined;
  isHub?: boolean;
  hubVersion?: string | null;
  onClick: () => void;
}) {
  const { t } = useTranslation('servers');
  const isOnline = status?.status === 'online';
  const hasDrift = !isHub && isOnline && status?.versionMatch === false;
  const host = server.type === 'agent' && server.host
    ? `${server.host}:${server.agentPort ?? 3002}`
    : server.sshHost ?? '';

  const connectionText = (() => {
    if (isHub) return null;
    if (isOnline) {
      const transport = server.type === 'agent'
        ? `agent HTTP/WS :${server.agentPort ?? 3002} · Tailscale`
        : 'SSH';
      return t('status.connectedVia', { transport });
    }
    return t('status.disconnected');
  })();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        border: `1px solid ${isHub ? 'color-mix(in srgb, var(--warning) 40%, transparent)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-card)',
        padding: '11px 13px',
        cursor: 'pointer',
        opacity: isOnline || isHub ? 1 : 0.75,
        transition: 'border-color 0.15s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent) 45%, transparent)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = isHub ? 'color-mix(in srgb, var(--warning) 40%, transparent)' : 'var(--border)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)', fontWeight: 700 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: isOnline || isHub ? 'var(--success)' : 'var(--text-dim)',
          opacity: isOnline || isHub ? 1 : 0.5,
        }} />
        <span>{isHub ? 'AZITO Hub' : server.name}</span>
        <Chip tone={server.type === 'local' ? 'accent' : 'purple'} style={{ marginLeft: 'auto' }}>{server.type}</Chip>
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)',
        marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap',
      }}>
        {host && <span>{host}</span>}
        {server.agentVersion && <span>{server.agentVersion.slice(0, 7)}</span>}
        {hasDrift && <span style={{ color: 'var(--warning)' }}>{t('status.versionDrift', { version: (server.agentVersion ?? '').slice(0, 7) })}</span>}
      </div>
      {connectionText && (
        <div style={{
          marginTop: 6, fontSize: 'var(--font-xs)', color: 'var(--text-dim)',
          borderTop: '1px dashed var(--border)', paddingTop: 6,
        }}>
          {connectionText}
        </div>
      )}
    </div>
  );
}
