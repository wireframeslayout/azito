import { useTranslation } from 'react-i18next';
import FormField from '../FormField';
import { FormSelect } from './FormInput';

export interface PhaseConfigEntry {
  sidekick?: string;
  enabled?: boolean;
}

export interface SidekickOption {
  name: string;
  isDefault: boolean;
}

interface PhaseConfigCardProps {
  phaseLabel: string;
  options: SidekickOption[];
  value: PhaseConfigEntry | undefined;
  onChange: (next: PhaseConfigEntry) => void;
}

export default function PhaseConfigCard({ phaseLabel, options, value, onChange }: PhaseConfigCardProps) {
  const { t } = useTranslation('common');
  const enabled = value?.enabled !== false;
  const defaultOption = options.find((o) => o.isDefault);
  const selectedSidekick = value?.sidekick ?? '';

  const handleToggleEnabled = () => {
    const next: PhaseConfigEntry = { ...value, enabled: !enabled };
    onChange(next);
  };

  const handleSidekickChange = (name: string) => {
    const next: PhaseConfigEntry = { ...value };
    if (name) {
      next.sidekick = name;
    } else {
      delete next.sidekick;
    }
    onChange(next);
  };

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text)' }}>{phaseLabel}</span>
        <label className="toggle">
          <input type="checkbox" checked={enabled} onChange={handleToggleEnabled} />
          <span className="toggle-slider" />
        </label>
      </div>
      {enabled && (
        <div style={{ marginTop: 12 }}>
          <FormField
            label={t('phaseConfig.sidekick')}
            hint={defaultOption ? t('phaseConfig.hintWithDefault', { defaultName: defaultOption.name }) : t('phaseConfig.hintNoDefault')}
          >
            <FormSelect value={selectedSidekick} onChange={(e) => handleSidekickChange(e.target.value)}>
              <option value="">{defaultOption ? t('phaseConfig.defaultOption', { defaultName: defaultOption.name }) : t('phaseConfig.selectSidekick')}</option>
              {options.map((o) => (
                <option key={o.name} value={o.name}>{o.name}{o.isDefault ? t('phaseConfig.defaultSuffix') : ''}</option>
              ))}
            </FormSelect>
          </FormField>
        </div>
      )}
    </div>
  );
}
