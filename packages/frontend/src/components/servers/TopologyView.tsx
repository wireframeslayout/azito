import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { paths } from '../../paths';
import type { Server, ServerStatus } from '../../hooks/useServerManagement';
import { Chip } from '../ui';

interface TopologyViewProps {
  servers: Server[];
  statuses: Record<string, ServerStatus>;
}

const NODE_W = 260;
const NODE_H = 90;
const HUB_X = 60;
const REMOTE_X = 500;
const START_Y = 40;
const GAP_Y = 24;

function statusDot(st: ServerStatus | undefined): { color: string; labelKey: string } {
  if (!st || st.status === 'checking') return { color: 'var(--text-dim)', labelKey: 'topology.checking' };
  if (st.status === 'online') return { color: 'var(--success)', labelKey: 'topology.online' };
  if (st.status === 'offline') return { color: 'var(--text-dim)', labelKey: 'topology.offline' };
  return { color: 'var(--warning)', labelKey: 'topology.error' };
}

function typeTone(type: string): 'accent' | 'purple' | 'default' {
  if (type === 'local') return 'accent';
  if (type === 'agent') return 'purple';
  return 'default';
}

export default function TopologyView({ servers, statuses }: TopologyViewProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('servers');

  const hub = useMemo(() => servers.find((s) => s.type === 'local'), [servers]);
  const remotes = useMemo(() => servers.filter((s) => s.type !== 'local'), [servers]);

  const hubY = useMemo(() => {
    if (remotes.length === 0) return START_Y;
    const totalH = remotes.length * NODE_H + (remotes.length - 1) * GAP_Y;
    return START_Y + totalH / 2 - NODE_H / 2;
  }, [remotes.length]);

  const totalHeight = useMemo(() => {
    const remoteBottom = START_Y + remotes.length * NODE_H + (remotes.length - 1) * GAP_Y;
    return Math.max(remoteBottom, hubY + NODE_H) + 40;
  }, [remotes.length, hubY]);

  const edges = useMemo(() => {
    return remotes.map((srv, i) => {
      const st = statuses[srv.name];
      const isOnline = st?.status === 'online';
      const hasDrift = isOnline && st?.versionMatch === false;
      const ry = START_Y + i * (NODE_H + GAP_Y);
      const hubCenterY = hubY + NODE_H / 2;
      const remoteCenterY = ry + NODE_H / 2;
      const startX = HUB_X + NODE_W;
      const endX = REMOTE_X;
      const midX = (startX + endX) / 2;
      const r = 8;

      let path: string;
      if (Math.abs(hubCenterY - remoteCenterY) < 2) {
        path = `M ${startX} ${hubCenterY} L ${endX} ${remoteCenterY}`;
      } else {
        const dy = remoteCenterY > hubCenterY ? 1 : -1;
        path = [
          `M ${startX} ${hubCenterY}`,
          `L ${midX - r} ${hubCenterY}`,
          `Q ${midX} ${hubCenterY} ${midX} ${hubCenterY + dy * r}`,
          `L ${midX} ${remoteCenterY - dy * r}`,
          `Q ${midX} ${remoteCenterY} ${midX + r} ${remoteCenterY}`,
          `L ${endX} ${remoteCenterY}`,
        ].join(' ');
      }

      const transport = srv.type === 'agent'
        ? `agent HTTP/WS :${srv.agentPort ?? 3002}`
        : 'SSH';
      const edgeLabel = isOnline
        ? `${transport} · Tailscale`
        : t('topology.disconnected');

      return {
        key: srv.name,
        path,
        isOnline,
        hasDrift,
        labelX: midX,
        labelY: (hubCenterY + remoteCenterY) / 2 - 10,
        edgeLabel,
      };
    });
  }, [remotes, statuses, hubY, t]);

  return (
    <div style={{ position: 'relative', width: '100%', minHeight: totalHeight, overflow: 'auto' }}>
      <svg
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        viewBox={`0 0 ${REMOTE_X + NODE_W + 40} ${totalHeight}`}
        preserveAspectRatio="xMinYMin meet"
      >
        {edges.map((e) => (
          <path
            key={e.key}
            d={e.path}
            fill="none"
            stroke={e.isOnline ? 'var(--accent)' : 'var(--text-dim)'}
            strokeWidth={e.isOnline ? 1.8 : 1.5}
            strokeDasharray={e.isOnline ? undefined : '6 5'}
            opacity={e.isOnline ? 1 : 0.6}
          />
        ))}
      </svg>

      {hub && (
        <ServerNode
          server={hub}
          status={statuses[hub.name]}
          x={HUB_X}
          y={hubY}
          isHub
          hubVersion={hub.hubVersion ?? null}
          onClick={() => navigate(paths.server(hub.name, 'overview'))}
        />
      )}

      {remotes.map((srv, i) => (
        <ServerNode
          key={srv.name}
          server={srv}
          status={statuses[srv.name]}
          x={REMOTE_X}
          y={START_Y + i * (NODE_H + GAP_Y)}
          hubVersion={hub?.hubVersion ?? null}
          onClick={() => navigate(paths.server(srv.name, 'overview'))}
        />
      ))}

      {edges.map((e) => (
        <div
          key={`label-${e.key}`}
          style={{
            position: 'absolute',
            left: e.labelX - 80,
            top: e.labelY,
            fontFamily: 'var(--mono)',
            fontSize: 'var(--font-xs)',
            color: 'var(--text-dim)',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-full)',
            padding: '2px 9px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {e.edgeLabel}
        </div>
      ))}

      <div style={{
        position: 'absolute', right: 14, bottom: 12,
        fontSize: 'var(--font-xs)', color: 'var(--text-dim)',
        background: 'color-mix(in srgb, var(--bg-card) 80%, transparent)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        padding: '8px 12px', lineHeight: 1.9,
      }}>
        ─ {t('topology.online')}　- - {t('topology.disconnected')}<br />
        ⚠ {t('topology.versionMismatch')}
      </div>
    </div>
  );
}

function ServerNode({
  server,
  status,
  x,
  y,
  isHub,
  hubVersion,
  onClick,
}: {
  server: Server;
  status: ServerStatus | undefined;
  x: number;
  y: number;
  isHub?: boolean;
  hubVersion: string | null;
  onClick: () => void;
}) {
  const { t } = useTranslation('servers');
  const st = statusDot(status);
  const isOnline = status?.status === 'online';
  const hasDrift = !isHub && isOnline && status?.versionMatch === false;
  const host = server.type === 'agent' && server.host
    ? `${server.host}:${server.agentPort ?? 3002}`
    : server.sshHost ?? '';
  const version = isHub ? (hubVersion ?? '') : (server.agentVersion ?? '');

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: NODE_W,
        background: 'var(--bg-card)',
        border: `1px solid ${isHub ? 'color-mix(in srgb, var(--warning) 40%, transparent)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '12px 14px',
        cursor: 'pointer',
        boxShadow: '0 6px 18px rgba(0,0,0,.35)',
        opacity: isOnline || isHub ? 1 : 0.75,
        transition: 'border-color 0.15s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent) 45%, transparent)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = isHub ? 'color-mix(in srgb, var(--warning) 40%, transparent)' : 'var(--border)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--font-sm)', fontWeight: 700 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isHub ? 'AZITO Hub' : server.name}
        </span>
        <Chip tone={typeTone(server.type)}>{server.type}</Chip>
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)',
        marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap',
      }}>
        {host && <span>{host}</span>}
        {version && <span>{version.slice(0, 7)}</span>}
      </div>
      {hasDrift && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--warning)',
          marginTop: 2,
        }}>
          {t('status.versionDrift', { version: (server.agentVersion ?? '').slice(0, 7) })}
        </div>
      )}
    </div>
  );
}
