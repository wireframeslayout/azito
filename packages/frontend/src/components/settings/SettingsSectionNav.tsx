import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { SETTINGS_SECTIONS } from './settingsSections';
import type { SettingsSectionId } from './settingsSections';

interface SettingsSectionNavProps {
  activeSection: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}

/**
 * Desktop sidebar for the global Settings page. Mirrors ServerSectionNav's
 * construction (fixed-width nav column, `.list-row` interaction states) —
 * intentionally has no title/heading of its own: GlobalPageLayout's outer
 * header already carries "Settings".
 */
export default function SettingsSectionNav({ activeSection, onSelect }: SettingsSectionNavProps) {
  const { t } = useTranslation();
  return (
    <nav
      style={{
        width: 240,
        minWidth: 240,
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--ws-surface)',
      }}
    >
      <div className="mobile-scroll-inset" style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {SETTINGS_SECTIONS.map((s) => {
          const isActive = s.id === activeSection;
          return (
            <button
              key={s.id}
              type="button"
              className={`list-row${isActive ? ' row-selected' : ''}`}
              onClick={() => onSelect(s.id)}
              aria-current={isActive ? 'page' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 12px',
                margin: '1px 0',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                font: 'inherit',
                fontSize: 'var(--font-md)',
                textAlign: 'left',
                cursor: 'pointer',
                color: isActive ? 'var(--accent)' : 'var(--text)',
              }}
            >
              <span style={{ width: 20, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name={s.icon} size={16} />
              </span>
              {t(s.labelKey)}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
