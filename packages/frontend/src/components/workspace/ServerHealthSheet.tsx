import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ServerHealthDetailBody, healthReasonText } from '../statusbar/ResourceDropdown';
import { HEALTH_CHIP_TOKENS } from '../statusbar/HealthDot';
import {
  getHealthLevel,
  getWorstHealth,
  useServerResourceDetail,
  useServerResourcesContext,
} from '../../hooks/useServerResources';
import type { ServerResourceEntry } from '../../hooks/useServerResources';

// グラバーの下スワイプで閉じる際、指を離した時点でこれ以上ドラッグしていれば「閉じる」と
// みなす距離（px）。モック（S6/M1）のボトムシート共通挙動。
const SWIPE_CLOSE_THRESHOLD = 80;

interface ServerHealthSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * サーバーヘルスのボトムシート（Issue #69 T6）。SP の M1 メニュー「サーバーヘルス」行から開く。
 * 中身（MEM/CPU/DISK メーター・ウィンドウ別メモリ一覧）はデスクトップの
 * `statusbar/ResourceDropdown.tsx` からコンポーネント抽出した `ServerHealthDetailBody` を
 * そのまま共有し、ロジックの重複や見た目のコピーを持たない。
 */
export function ServerHealthSheet({ open, onClose }: ServerHealthSheetProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const { t: tCommon } = useTranslation('common');
  const servers = useServerResourcesContext();
  const worstHealth = getWorstHealth(servers.map((s) => getHealthLevel(s.measurement)));
  const worstServer = servers.find((s) => getHealthLevel(s.measurement) === worstHealth) ?? null;
  const worstMemUsedPercent = worstServer?.measurement ? 100 - worstServer.measurement.memAvailablePercent : null;

  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touchStartY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    setDragging(true);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const delta = e.touches[0].clientY - touchStartY.current;
    if (delta > 0) setDragY(delta);
  };
  const handleTouchEnd = () => {
    setDragging(false);
    touchStartY.current = null;
    if (dragY > SWIPE_CLOSE_THRESHOLD) {
      onClose();
    }
    setDragY(0);
  };

  if (!open) return null;

  const chipTokens = HEALTH_CHIP_TOKENS[worstHealth];

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 129 }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('workspace:mobile.serverHealth')}
        className="server-health-sheet"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 130,
          maxHeight: '78vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-solid)',
          borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          boxShadow: 'var(--shadow-3)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          transform: `translateY(${dragY}px)`,
          transition: dragging ? 'none' : 'transform 0.2s ease',
        }}
      >
        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 6px', touchAction: 'none', flexShrink: 0 }}
        >
          <span aria-hidden="true" style={{ width: 36, height: 4, borderRadius: 'var(--radius-full)', background: 'var(--bg-hover)' }} />
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '0 16px 12px', flexShrink: 0,
        }}>
          <span style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--text)' }}>
            {t('workspace:mobile.serverHealth')}
          </span>
          <span style={{
            fontSize: 'var(--font-xs)', fontWeight: 600, padding: '3px 9px', borderRadius: 'var(--radius-full)',
            background: chipTokens.bg, color: chipTokens.fg, flexShrink: 0,
          }}>
            {healthReasonText(worstHealth, worstMemUsedPercent, tCommon)}
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 6px 12px' }}>
          {servers.length === 0 ? (
            <div style={{ padding: '14px 10px', color: 'var(--text-dim)', fontSize: 'var(--font-md)', textAlign: 'center' }}>
              {t('common:statusbar.fetchingResources')}
            </div>
          ) : (
            servers.map((s, i) => <ServerHealthSection key={s.serverName} server={s} isFirst={i === 0} />)
          )}
        </div>
      </div>
    </>
  );
}

function ServerHealthSection({ server, isFirst }: { server: ServerResourceEntry; isFirst: boolean }) {
  const { detail, deleteLoading, handleDeleteWindow } = useServerResourceDetail(server.serverName);

  return (
    <section style={{ padding: '10px 10px 4px', borderTop: isFirst ? 'none' : '1px solid var(--border)' }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', letterSpacing: '0.1em',
        color: 'var(--text-dim)', textTransform: 'uppercase', padding: '0 0 8px',
      }}>
        {(detail?.type ?? server.type)} · {server.serverName}
      </div>
      <ServerHealthDetailBody
        detail={detail}
        meterWidth={110}
        onDeleteWindow={handleDeleteWindow}
        deleteLoading={deleteLoading}
      />
    </section>
  );
}
