import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { HealthDot } from './HealthDot';
import { ResourceMeter } from './ResourceMeter';
import { useServerResourceDetail } from '../../hooks/useServerResources';
import type { HealthLevel, ServerResourceDetail } from '../../hooks/useServerResources';
import { Icon } from '../ui/Icon';

export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function healthReasonText(level: HealthLevel, memUsedPercent: number | null, t: TFunction): string {
  if (level === 'healthy') return t('common:statusbar.healthy');
  if (level === 'critical') {
    if (memUsedPercent === null) return t('common:statusbar.disconnected');
    return t('common:statusbar.criticalMemory', { percent: Math.round(memUsedPercent) });
  }
  return t('common:statusbar.warningMemory', { percent: Math.round(memUsedPercent ?? 0) });
}

interface ResourceDropdownContentProps {
  serverName: string;
  health: HealthLevel;
  meterWidth?: number;
}

export function ResourceDropdownContent({ serverName, health, meterWidth = 110 }: ResourceDropdownContentProps) {
  const { t } = useTranslation('common');
  const { detail, deleteLoading, handleDeleteWindow } = useServerResourceDetail(serverName);

  const m = detail?.measurement;
  const memUsedPercent = m ? 100 - m.memAvailablePercent : null;

  return (
    <div>
      <div style={{
        padding: '6px 10px 8px',
        fontFamily: 'var(--mono)',
        fontSize: 'var(--font-xs)',
        letterSpacing: '0.1em',
        color: 'var(--text-dim)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <HealthDot level={health} />
          <span style={{ textTransform: 'uppercase' }}>{serverName}</span>
          <span style={{ letterSpacing: 0 }}>— {healthReasonText(health, memUsedPercent, t)}</span>
        </span>
        <span>{detail?.type ?? ''}</span>
      </div>

      <ServerHealthDetailBody
        detail={detail}
        meterWidth={meterWidth}
        onDeleteWindow={handleDeleteWindow}
        deleteLoading={deleteLoading}
      />
    </div>
  );
}

interface ServerHealthDetailBodyProps {
  detail: ServerResourceDetail | null;
  meterWidth: number;
  onDeleteWindow: (target: string) => void;
  deleteLoading: string | null;
}

/**
 * MEM/CPU/DISK メーター＋ウィンドウ別メモリ一覧。デスクトップの `ResourceDropdownContent` と
 * SP の `ServerHealthSheet`（Issue #69 T6）が共有する本体（コピー禁止・見た目はデスクトップ側の
 * 元実装をそのまま維持）。
 */
export function ServerHealthDetailBody({ detail, meterWidth, onDeleteWindow, deleteLoading }: ServerHealthDetailBodyProps) {
  const { t } = useTranslation('common');
  const m = detail?.measurement;
  const memUsedPercent = m ? 100 - m.memAvailablePercent : null;
  const memUsedBytes = m ? m.memTotalBytes - m.memAvailableBytes : null;

  if (!m) {
    return (
      <div style={{ padding: '12px 10px', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
        {t('statusbar.fetchingResources')}
      </div>
    );
  }

  return (
    <>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '4px 10px 10px',
        borderBottom: '1px solid var(--border)',
        marginBottom: 6,
      }}>
        <MetricRow
          label="MEM"
          value={memUsedPercent ?? 0}
          detail={`${formatBytes(memUsedBytes ?? 0)} / ${formatBytes(m.memTotalBytes)}`}
          warning={memUsedPercent !== null && memUsedPercent >= 60}
          meterWidth={meterWidth}
        />
        <MetricRow
          label="CPU"
          value={Math.min(100, m.loadPerCore * 100)}
          detail={`${Math.round(m.loadPerCore * 100)}% · load ${m.loadPerCore.toFixed(1)}`}
          warning={m.loadPerCore > 1.5}
          meterWidth={meterWidth}
        />
        {m.diskUsedPercent !== null && (
          <MetricRow
            label="DISK"
            value={m.diskUsedPercent}
            detail={`${formatBytes(m.diskUsedBytes ?? 0)} / ${formatBytes(m.diskTotalBytes ?? 0)}`}
            warning={m.diskUsedPercent > 80}
            meterWidth={meterWidth}
          />
        )}
      </div>

      {detail?.windows && detail.windows.length > 0 && (
        <div>
          {detail.windows.map((w) => (
            <div
              key={w.target}
              className="row-hover"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--font-sm)',
              }}
            >
              <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {w.target}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>
                {formatBytes(w.rssBytes)}
              </span>
              <button
                onClick={() => onDeleteWindow(w.target)}
                disabled={deleteLoading === w.target}
                style={{
                  color: 'var(--danger)',
                  fontSize: 'var(--font-xs)',
                  cursor: deleteLoading === w.target ? 'not-allowed' : 'pointer',
                  border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '1px 7px',
                  background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                  opacity: deleteLoading === w.target ? 0.5 : 1,
                  flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                }}
              >
                <Icon name="close" size={14} /> {t('common:actions.delete')}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function MetricRow({ label, value, detail, warning, meterWidth }: {
  label: string;
  value: number;
  detail: string;
  warning: boolean;
  meterWidth: number;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontFamily: 'var(--mono)',
      fontSize: 'var(--font-xs)',
      color: 'var(--text-dim)',
    }}>
      <b style={{ color: 'var(--text)', fontWeight: 600, minWidth: 34 }}>{label}</b>
      <ResourceMeter value={value} warning={warning} width={meterWidth} />
      <span>{detail}</span>
    </div>
  );
}
