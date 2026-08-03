import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalTheme } from '../../../hooks/useTerminalTheme';
import { ANSI_KEYS } from '../../../themes/types';
import type { TerminalPalette } from '../../../themes/types';
import { findPreset } from '../../../themes/presets';
import { ColorSwatchInput } from '../../ui/ColorSwatchInput';
import { FormInput, Button } from '../../ui';

const CORE_FIELDS: { key: keyof TerminalPalette; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'selectionBackground', label: 'Selection' },
];

export default function PaletteEditor() {
  const { t } = useTranslation('settings');
  const { store, updatePalette, updateUiBorder, selectPreset, saveAsCustomTheme } = useTerminalTheme();
  const palette = store.global.palette;
  const [themeName, setThemeName] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  const handleCoreChange = useCallback((key: keyof TerminalPalette, value: string) => {
    updatePalette({ [key]: value });
  }, [updatePalette]);

  const handleAnsiChange = useCallback((index: number, value: string) => {
    updatePalette({ [ANSI_KEYS[index]]: value });
  }, [updatePalette]);

  const handleReset = useCallback(() => {
    const baseId = store.global.presetId.startsWith('user-') ? 'aurora' : store.global.presetId;
    const preset = findPreset(baseId) || findPreset('aurora');
    if (preset) selectPreset(preset.id);
  }, [store.global.presetId, selectPreset]);

  const handleSave = useCallback(() => {
    const name = themeName.trim() || 'My Theme';
    saveAsCustomTheme(name);
    setSavedMsg(`"${name}" saved`);
    setTimeout(() => setSavedMsg(''), 3000);
  }, [themeName, saveAsCustomTheme]);

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
      <div style={{ fontSize: 'var(--font-md)', fontWeight: 650, marginBottom: 2 }}>{t('appearance.customizeColors')}</div>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
        {t('appearance.customizeColorsDescription')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
        {CORE_FIELDS.map(({ key, label }) => (
          <ColorSwatchInput
            key={key}
            label={label}
            value={palette[key] as string}
            onChange={(v) => handleCoreChange(key, v)}
          />
        ))}
        <ColorSwatchInput
          label={t('appearance.uiBorder')}
          value={store.global.uiBorder ?? '#30363d'} // lint-allow: hex - user-editable palette default (matches the GitHub-dark preset border)
          onChange={updateUiBorder}
        />
      </div>

      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>
        {t('appearance.ansiColors')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6, maxWidth: 380 }}>
        {ANSI_KEYS.map((key, i) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              const input = document.getElementById(`ansi-color-${i}`) as HTMLInputElement;
              input?.click();
            }}
            style={{
              position: 'relative',
              aspectRatio: '1',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid rgba(255,255,255,0.14)',
              cursor: 'pointer',
              padding: 0,
              background: palette[key],
            }}
            aria-label={`ANSI ${key}`}
          >
            <input
              id={`ansi-color-${i}`}
              type="color"
              value={palette[key]}
              onChange={(e) => handleAnsiChange(i, e.target.value)}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
            />
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <FormInput
            value={themeName}
            onChange={(e) => setThemeName(e.target.value)}
            placeholder="Theme name (e.g. My Aurora)"
          />
        </div>
        <Button onClick={handleSave}>{t('appearance.saveAsCustomTheme')}</Button>
        <Button onClick={handleReset}>{t('appearance.resetToPreset')}</Button>
      </div>
      {savedMsg && (
        <div role="status" style={{ fontSize: 'var(--font-sm)', color: 'var(--success)', marginTop: 6 }}>
          {savedMsg}
        </div>
      )}
    </div>
  );
}
