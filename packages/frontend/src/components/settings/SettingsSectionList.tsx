import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { SETTINGS_SECTIONS } from './settingsSections';
import type { SettingsSectionId } from './settingsSections';

interface SettingsSectionListProps {
  onSelect: (id: SettingsSectionId) => void;
}

/**
 * Mobile (<=768px) entry point for the global Settings page: a list of
 * sections with a chevron, mirroring ServerDrilldownMenu's row construction
 * (card rows, since a persistent chevron needs a non-transparent resting
 * background — `.list-row`'s hover-only arrow doesn't work on touch).
 * Selecting a row pushes the section's detail view (see GlobalSettingsPage).
 */
export default function SettingsSectionList({ onSelect }: SettingsSectionListProps) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: '8px 12px' }}>
      <style>{`
        .azt-settings-row { background: var(--bg-card); transition: background 0.15s ease; }
        .azt-settings-row:hover { background: var(--bg-hover); }
        .azt-settings-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      `}</style>
      {SETTINGS_SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className="azt-settings-row"
          onClick={() => onSelect(s.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            width: '100%',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '12px 13px',
            marginBottom: 8,
            fontSize: 'var(--font-sm)',
            color: 'var(--text)',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <span style={{ width: 20, textAlign: 'center', color: 'var(--text-dim)', flexShrink: 0, display: 'inline-flex', justifyContent: 'center' }}>
            <Icon name={s.icon} size={16} />
          </span>
          <span style={{ flex: 1 }}>{t(s.labelKey)}</span>
          <span aria-hidden="true" style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>›</span>
        </button>
      ))}
    </div>
  );
}
