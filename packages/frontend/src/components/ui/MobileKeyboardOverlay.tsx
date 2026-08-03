import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QuickActionButtons, type QuickActionButton } from './QuickActionButtons';
import { Icon } from './Icon';

export interface MobileKeyboardOverlayProps {
  onSendKey: (key: string) => void;
  onClose: () => void;
}

const BAR_WIDTH = 400;
// 2段構成: 各行30px + 行間6px + 上下padding 6px*2
const BAR_HEIGHT = 78;
const EDGE_MARGIN = 8;

/** 320px幅などの狭い端末でも画面内に収まるよう、実効幅をviewportに合わせて縮める */
function getEffectiveBarWidth(): number {
  const width = typeof window !== 'undefined' ? window.innerWidth : BAR_WIDTH + EDGE_MARGIN * 2;
  return Math.min(BAR_WIDTH, width - EDGE_MARGIN * 2);
}

const ARROW_ROW_BUTTONS: QuickActionButton[] = [
  { label: <Icon name="arrow-left" size={14} />, key: 'Left' },
  { label: <Icon name="arrow-up" size={14} />, key: 'Up' },
  { label: <Icon name="arrow-down" size={14} />, key: 'Down' },
  { label: <Icon name="arrow-right" size={14} />, key: 'Right' },
  { label: 'Tab', key: 'Tab' },
];

const CONTROL_ROW_BUTTONS: QuickActionButton[] = [
  { label: 'y', key: 'y' },
  { label: 'n', key: 'n' },
  { label: 'Enter', key: 'Enter', style: { background: 'var(--accent-a15)', borderColor: 'var(--accent-a35)', color: 'var(--accent)' } },
  { label: 'Esc', key: 'Escape', style: { color: 'var(--warning)', borderColor: 'var(--warning-a35)' } },
  { label: 'Ctrl+C', key: 'C-c', style: { color: 'var(--danger)', borderColor: 'var(--danger-a35)' } },
  { label: 'Ctrl+D', key: 'C-d' },
];

function measureSafeAreaInsetBottom(): number {
  if (typeof document === 'undefined') return 0;
  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.bottom = 'env(safe-area-inset-bottom, 0px)';
  probe.style.height = '0px';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);
  const bottom = window.innerHeight - probe.getBoundingClientRect().bottom;
  document.body.removeChild(probe);
  return Math.max(0, bottom);
}

function getInitialPosition(): { x: number; y: number } {
  const width = typeof window !== 'undefined' ? window.innerWidth : BAR_WIDTH + EDGE_MARGIN * 2;
  const height = typeof window !== 'undefined' ? window.innerHeight : 800;
  const barWidth = getEffectiveBarWidth();
  const safeAreaBottom = measureSafeAreaInsetBottom();
  const x = Math.max(EDGE_MARGIN, Math.min(width - barWidth - EDGE_MARGIN, (width - barWidth) / 2));
  const y = Math.max(EDGE_MARGIN, height - BAR_HEIGHT - 80 - safeAreaBottom);
  return { x, y };
}

function clampPosition(x: number, y: number): { x: number; y: number } {
  const width = typeof window !== 'undefined' ? window.innerWidth : BAR_WIDTH + EDGE_MARGIN * 2;
  const height = typeof window !== 'undefined' ? window.innerHeight : 800;
  const barWidth = getEffectiveBarWidth();
  return {
    x: Math.max(EDGE_MARGIN, Math.min(width - barWidth - EDGE_MARGIN, x)),
    y: Math.max(EDGE_MARGIN, Math.min(height - BAR_HEIGHT - EDGE_MARGIN, y)),
  };
}

export function MobileKeyboardOverlay({ onSendKey, onClose }: MobileKeyboardOverlayProps) {
  const { t } = useTranslation('common');
  const [position, setPosition] = useState(getInitialPosition);
  const [barWidth] = useState(getEffectiveBarWidth);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const handleGripPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
    };
  }, [position.x, position.y]);

  const handleGripPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    setPosition(clampPosition(drag.originX + dx, drag.originY + dy));
  }, []);

  const handleGripPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === e.pointerId) {
      dragStateRef.current = null;
    }
  }, []);

  return (
    <div
      role="dialog"
      aria-label={t('mobileKeyboard.controls')}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: barWidth,
        zIndex: 119,
        borderRadius: 'var(--radius-lg)',
        // 後ろのターミナル内容が透けて見えるよう、blurは掛けず背景のみ約40%透過にする
        background: 'rgba(13, 17, 23, 0.6)',
        border: '1px solid var(--border)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45)',
        padding: '6px 8px',
        display: 'flex',
        alignItems: 'stretch',
        gap: 6,
      }}
    >
      <div
        onPointerDown={handleGripPointerDown}
        onPointerMove={handleGripPointerMove}
        onPointerUp={handleGripPointerUp}
        onPointerCancel={handleGripPointerUp}
        role="separator"
        aria-label={t('mobileKeyboard.dragToMove')}
        style={{
          width: 24,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-dim)',
          fontSize: 'var(--font-lg)',
          lineHeight: 1,
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        ⠿
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
        <QuickActionButtons buttons={ARROW_ROW_BUTTONS} onAction={onSendKey} />
        <QuickActionButtons buttons={CONTROL_ROW_BUTTONS} onAction={onSendKey} />
      </div>

      <button
        type="button"
        className="kbd-key"
        aria-label={t('mobileKeyboard.close')}
        onClick={onClose}
        style={{
          width: 24,
          flexShrink: 0,
          alignSelf: 'stretch',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid rgba(139, 148, 158, 0.28)',
          background: 'rgba(230, 237, 243, 0.05)',
          color: 'var(--text-dim)',
          lineHeight: 1,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'inherit',
        }}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
