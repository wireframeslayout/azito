import { useTranslation } from 'react-i18next';
import type { SidebarMode } from '../../pages/workspace/types';
import { Icon, type IconName } from '../ui/Icon';
import { BottomSheet } from '../ui/BottomSheet';

interface MobileModeSheetProps {
  open: boolean;
  onClose: () => void;
  currentMode: SidebarMode;
  onSwitchMode: (mode: SidebarMode) => void;
}

const MODE_ITEMS: Array<{ mode: SidebarMode; labelKey: string; icon: IconName }> = [
  { mode: 'windows', labelKey: 'menu.windows', icon: 'windows' },
  { mode: 'tasks', labelKey: 'menu.tasks', icon: 'tasks' },
  { mode: 'files', labelKey: 'menu.files', icon: 'files' },
  { mode: 'repos', labelKey: 'menu.repositories', icon: 'repos' },
  { mode: 'storage', labelKey: 'menu.storage', icon: 'storage' },
  { mode: 'settings', labelKey: 'menu.settings', icon: 'settings' },
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

export function MobileModeSheet({ open, onClose, currentMode, onSwitchMode }: MobileModeSheetProps) {
  const { t } = useTranslation('workspace');
  return (
    <BottomSheet open={open} onClose={onClose} title={t('mobile.mode')}>
      {MODE_ITEMS.map((item) => (
        <button
          key={item.mode}
          className={`glass-popover-item${currentMode === item.mode ? ' selected' : ''}`}
          onClick={() => {
            onSwitchMode(item.mode);
            onClose();
          }}
          style={itemStyle}
        >
          <Icon name={item.icon} size={16} />
          <span>{t(item.labelKey)}</span>
        </button>
      ))}
    </BottomSheet>
  );
}
