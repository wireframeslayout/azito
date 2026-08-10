import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { paths } from '../../paths';
import { Icon } from '../ui/Icon';
import { BottomSheet } from '../ui/BottomSheet';
import { useSystemUpdate } from '../../hooks/useSystemUpdate';
import { HealthDot, type DotLevel } from '../statusbar/HealthDot';
import { GLOBAL_NAV_ITEMS, SETTINGS_NAV_ITEM } from './globalNavItems';

interface MobileGlobalMenuSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * 「その他」シートへ退避した機能（Issue #69 修正4）。下部バーが5項目のラベル付き
   * 構成へ刷新されたことで、旧 keyboard/アクティブウィンドウ/サーバーヘルスの各
   * アイコンボタンの置き場所を失った — 機能自体は削除せず、このシートの先頭セクションへ
   * 移設する。全て任意（呼び出し元の条件が揃わない場合は行ごと非表示、機能を失わない範囲で
   * 段階的に無効化できるようにする）。
   */
  onOpenKeyboard?: () => void;
  onOpenActiveWindows?: () => void;
  activeWindowsCount?: number;
  activeWindowsBlockedCount?: number;
  serverHealth?: DotLevel;
  onOpenServerHealth?: () => void;
}

const GLOBAL_ITEMS = [...GLOBAL_NAV_ITEMS, SETTINGS_NAV_ITEM];

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 10px',
  borderRadius: 'var(--radius-md)',
  width: '100%',
  border: 'none',
  fontSize: 'var(--font-md)',
  fontFamily: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--text)',
};

export function MobileGlobalMenuSheet({
  open, onClose, onOpenKeyboard, onOpenActiveWindows, activeWindowsCount, activeWindowsBlockedCount,
  serverHealth, onOpenServerHealth,
}: MobileGlobalMenuSheetProps) {
  const { t } = useTranslation(['workspace', 'projects', 'common']);
  const location = useLocation();
  const navigate = useNavigate();
  const { status: updateStatus } = useSystemUpdate();

  const hasStashedRow = !!onOpenKeyboard || !!onOpenActiveWindows || (!!onOpenServerHealth && !!serverHealth);

  return (
    <BottomSheet open={open} onClose={onClose} title={t('mobile.other')}>
      {onOpenKeyboard && (
        <button className="glass-popover-item" onClick={() => { onClose(); onOpenKeyboard(); }} style={itemStyle}>
          <Icon name="keyboard" size={16} />
          <span>{t('mobile.keyboardControls')}</span>
        </button>
      )}
      {onOpenActiveWindows && (
        <button className="glass-popover-item" onClick={() => { onClose(); onOpenActiveWindows(); }} style={itemStyle}>
          <Icon name="windows" size={16} />
          <span>{(activeWindowsCount ?? 0) > 0 ? t('activeWindows.titleWithCount', { count: activeWindowsCount }) : t('activeWindows.title')}</span>
          {(activeWindowsBlockedCount ?? 0) > 0 && (
            <span aria-hidden="true" style={{
              marginLeft: 'auto', width: 8, height: 8, borderRadius: 'var(--radius-full)', background: 'var(--danger)', flexShrink: 0,
            }} />
          )}
        </button>
      )}
      {onOpenServerHealth && serverHealth && (
        <button className="glass-popover-item" onClick={() => { onClose(); onOpenServerHealth(); }} style={itemStyle}>
          <HealthDot level={serverHealth} size={12} />
          <span>{t('mobile.serverHealth')}</span>
        </button>
      )}
      {hasStashedRow && <div style={{ height: 1, background: 'var(--border)', margin: '6px 4px' }} />}
      {GLOBAL_ITEMS.map((item) => (
        <button
          key={item.path}
          className={`glass-popover-item${location.pathname.startsWith(item.path) ? ' selected' : ''}`}
          onClick={() => {
            navigate(item.path);
            onClose();
          }}
          style={itemStyle}
        >
          <Icon name={item.icon} size={16} />
          <span>{t(item.labelKey)}</span>
        </button>
      ))}
      {updateStatus?.status === 'update-available' && (
        <>
          <div style={{ height: 1, background: 'var(--border)', margin: '6px 4px' }} />
          <button
            className="glass-popover-item"
            onClick={() => {
              navigate(paths.settings('system'));
              onClose();
            }}
            style={{ ...itemStyle, color: 'var(--accent)' }}
          >
            <Icon name="settings" size={16} />
            <span>{t('mobile.updateAvailable')}</span>
            <span style={{
              marginLeft: 'auto', fontSize: 'var(--font-xs)',
              background: 'var(--accent)', color: '#fff', borderRadius: 'var(--radius-full)', // lint-allow: hex - white text on solid accent fill; no on-color token yet
              minWidth: 16, height: 16, padding: '0 4px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
            }}>{updateStatus.commitsBehind}</span>
          </button>
        </>
      )}
    </BottomSheet>
  );
}
