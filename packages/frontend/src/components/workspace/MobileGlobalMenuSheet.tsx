import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { paths } from '../../paths';
import { Icon, type IconName } from '../ui/Icon';
import { BottomSheet } from '../ui/BottomSheet';
import { useSystemUpdate } from '../../hooks/useSystemUpdate';

interface MobileGlobalMenuSheetProps {
  open: boolean;
  onClose: () => void;
}

const GLOBAL_ITEMS: Array<{ labelKey: string; icon: IconName; path: string }> = [
  { labelKey: 'projects:sidebar.servers', icon: 'servers', path: paths.servers() },
  { labelKey: 'projects:sidebar.sidekicks', icon: 'sidekicks', path: paths.sidekicks() },
  { labelKey: 'projects:sidebar.units', icon: 'units', path: paths.units() },
  { labelKey: 'common:navigation.settings', icon: 'settings', path: paths.settings() },
];

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

export function MobileGlobalMenuSheet({ open, onClose }: MobileGlobalMenuSheetProps) {
  const { t } = useTranslation(['workspace', 'projects', 'common']);
  const location = useLocation();
  const navigate = useNavigate();
  const { status: updateStatus } = useSystemUpdate();

  return (
    <BottomSheet open={open} onClose={onClose} title={t('mobile.menu')}>
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
