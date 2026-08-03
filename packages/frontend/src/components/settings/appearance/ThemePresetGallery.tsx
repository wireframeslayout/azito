import { useTranslation } from 'react-i18next';
import { useTerminalTheme } from '../../../hooks/useTerminalTheme';
import { PRESET_THEMES } from '../../../themes/presets';
import { paletteAnsiArray } from '../../../themes/types';
import type { ThemeDefinition } from '../../../themes/types';
import { buildGradientCss } from '../../../themes/gradients';
import { IconButton } from '../../ui/IconButton';
import { Icon } from '../../ui/Icon';

function ThemeCard({ id, name, palette, background, selected, isCustom, isDefault, onSelect, onDelete, deleteTitle, defaultLabel }: {
  id: string;
  name: string;
  palette: ThemeDefinition['palette'];
  background: ThemeDefinition['background'];
  selected: boolean;
  isCustom: boolean;
  isDefault: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
  defaultLabel?: string;
}) {
  const ansi = paletteAnsiArray(palette);
  const thumbBg = background.mode === 'gradient' && background.gradient
    ? buildGradientCss(background.gradient, palette.background)
    : palette.background;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        background: 'var(--bg)',
        border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 0,
        cursor: 'pointer',
        textAlign: 'left' as const,
        overflow: 'hidden',
        color: 'var(--text)',
        boxShadow: selected ? '0 0 0 1px var(--accent), 0 0 12px var(--accent-a35)' : 'none',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      <div style={{
        height: 40, display: 'flex', alignItems: 'flex-end', padding: '5px 8px',
        fontFamily: "'JetBrainsMono Nerd Font', monospace", fontSize: 'var(--font-2xs)',
        background: thumbBg, color: palette.foreground, position: 'relative',
      }}>
        <span>$ npm run dev</span>
        <span style={{ position: 'absolute', top: 6, right: 8, display: 'flex', gap: 2 }}>
          {ansi.slice(1, 7).map((c, i) => (
            <i key={i} style={{ width: 7, height: 7, borderRadius: 'var(--radius-sm)', display: 'block', background: c }} />
          ))}
        </span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4,
        padding: '4px 8px 5px', fontSize: 'var(--font-xs)', fontWeight: 550,
        borderTop: '1px solid var(--border)', background: 'var(--bg-card)',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {isDefault && (
            <span style={{
              fontSize: 'var(--font-2xs)', color: '#58a6ff', // lint-allow: hex - "Default" badge tinted to match the aurora preset's UI accent
              border: '1px solid color-mix(in srgb, #58a6ff 45%, transparent)', // lint-allow: hex - same aurora preset tint
              borderRadius: 'var(--radius-full)', padding: '0 5px', fontWeight: 500, whiteSpace: 'nowrap',
            }}>
              {defaultLabel}
            </span>
          )}
          {isCustom && (
            <span style={{
              fontSize: 'var(--font-2xs)', color: 'var(--accent)',
              border: '1px solid var(--accent-a35)',
              borderRadius: 'var(--radius-full)', padding: '0 5px', fontWeight: 500, whiteSpace: 'nowrap',
            }}>
              Custom
            </span>
          )}
          {isCustom && onDelete && (
            <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <IconButton
                title={deleteTitle}
                size="sm"
                onClick={() => { onDelete(); }}
              >
                <Icon name="trash" size={14} />
              </IconButton>
            </span>
          )}
        </span>
      </div>
    </button>
  );
}

export default function ThemePresetGallery() {
  const { t } = useTranslation('settings');
  const { store, selectPreset, deleteCustomTheme } = useTerminalTheme();

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
      <div style={{ fontSize: 'var(--font-md)', fontWeight: 650, marginBottom: 2 }}>{t('appearance.colorTheme')}</div>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
        {t('appearance.colorThemeDescription')}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 8,
      }}>
        {PRESET_THEMES.map((preset) => (
          <ThemeCard
            key={preset.id}
            id={preset.id}
            name={preset.name}
            palette={preset.palette}
            background={preset.background}
            selected={store.global.presetId === preset.id}
            isCustom={false}
            isDefault={preset.id === 'aurora'}
            onSelect={() => selectPreset(preset.id)}
            defaultLabel={t('common:labels.default')}
          />
        ))}
        {Object.entries(store.customThemes).map(([id, theme]) => (
          <ThemeCard
            key={id}
            id={id}
            name={theme.name}
            palette={theme.palette}
            background={theme.background}
            selected={store.global.presetId === id}
            isCustom={true}
            isDefault={false}
            onSelect={() => {
              selectPreset(id);
            }}
            onDelete={() => deleteCustomTheme(id)}
            deleteTitle={t('appearance.deleteTheme')}
          />
        ))}
      </div>
    </div>
  );
}
