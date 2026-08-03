import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalTheme } from '../../../hooks/useTerminalTheme';
import { GRADIENT_COLOR_COUNT } from '../../../themes/gradients';
import type { GradientPattern, OverlayKind } from '../../../themes/types';
import { Slider, ColorSwatchInput, FormInput } from '../../ui';
import { useToast } from '../../../hooks/useToast';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const SCOPE_OPTIONS = [
  { value: 'terminal', label: 'Terminal only' },
  { value: 'app', label: 'Workspace' },
] as const;

const BG_TYPE_OPTIONS = [
  { value: 'gradient', label: 'Gradient' },
  { value: 'image', label: 'Image' },
  { value: 'none', label: 'Solid' },
] as const;

const PATTERN_OPTIONS: { value: GradientPattern; label: string }[] = [
  { value: 'aurora', label: 'Aurora' },
  { value: 'linear', label: 'Linear' },
  { value: 'glow', label: 'Glow' },
  { value: 'mesh', label: 'Mesh' },
];

const OVERLAY_OPTIONS: { value: OverlayKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'darken', label: 'Darken' },
  { value: 'color', label: 'Color tint' },
  { value: 'blur', label: 'Blur' },
  { value: 'gradient', label: 'Gradient' },
  { value: 'vignette', label: 'Vignette' },
];

export function SegmentedControl<T extends string>({ options, value, onChange, label }: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="azito-segmented" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default function BackgroundSettingsEditor() {
  const { t } = useTranslation('settings');
  const { store, updateBackground, updateGradient, setStoredImage } = useTerminalTheme();
  const { showToast } = useToast();
  const bg = store.global.background;
  const gradient = bg.gradient;
  const fileRef = useRef<HTMLInputElement>(null);

  const colorCount = GRADIENT_COLOR_COUNT[gradient?.pattern || 'aurora'] || 3;

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_SIZE) {
      showToast(t('appearance.fileTooLarge'));
      return;
    }
    setStoredImage(file);
    updateBackground({ mode: 'image', imageSource: { kind: 'stored' } });
  }, [setStoredImage, updateBackground, showToast]);

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
      <div style={{ fontSize: 'var(--font-md)', fontWeight: 650, marginBottom: 2 }}>{t('appearance.background')}</div>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
        {t('appearance.backgroundDescription')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>{t('appearance.scope')}</div>
          <SegmentedControl
            options={SCOPE_OPTIONS}
            value={bg.scope}
            onChange={(v) => updateBackground({ scope: v })}
            label={t('appearance.scope')}
          />
        </div>
        <div>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>{t('appearance.type')}</div>
          <SegmentedControl
            options={BG_TYPE_OPTIONS}
            value={bg.mode}
            onChange={(v) => updateBackground({ mode: v })}
            label={t('appearance.type')}
          />
        </div>
      </div>

      {bg.mode === 'gradient' && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>{t('appearance.pattern')}</div>
          <SegmentedControl
            options={PATTERN_OPTIONS}
            value={gradient?.pattern || 'aurora'}
            onChange={(v) => updateGradient({ pattern: v })}
            label={t('appearance.pattern')}
          />
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: 12, marginBottom: 5 }}>{t('appearance.colors')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${colorCount}, 1fr)`, gap: 8 }}>
            {(gradient?.colors || ['#ff9ac1', '#58a6ff', '#b48cff']).slice(0, colorCount).map((c, i) => ( // lint-allow: hex - aurora gradient default colors (mirrors themes/presets.ts), user-editable appearance default
              <ColorSwatchInput
                key={i}
                label={`Color ${i + 1}`}
                value={c}
                onChange={(v) => {
                  const colors = [...(gradient?.colors || ['#ff9ac1', '#58a6ff', '#b48cff'])]; // lint-allow: hex - aurora gradient default colors (mirrors themes/presets.ts), user-editable appearance default
                  colors[i] = v;
                  updateGradient({ colors });
                }}
              />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            {gradient?.pattern === 'linear' && (
              <Slider
                label="Angle"
                value={gradient?.angle ?? 135}
                min={0}
                max={360}
                step={5}
                onChange={(v) => updateGradient({ angle: v })}
                formatValue={(v) => `${v}°`}
              />
            )}
            <Slider
              label="Intensity"
              value={Math.round((gradient?.intensity ?? 0.5) * 100)}
              min={0}
              max={100}
              onChange={(v) => updateGradient({ intensity: v / 100 })}
              formatValue={(v) => `${v}%`}
            />
          </div>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: 8 }}>
            {t('appearance.gradientHint')}
          </div>
        </div>
      )}

      {bg.mode === 'image' && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>{t('appearance.imageUrl')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <FormInput
                value={bg.imageSource?.kind === 'url' ? bg.imageSource.url : ''}
                onChange={(e) => updateBackground({ imageSource: { kind: 'url', url: e.target.value } })}
                placeholder="https://example.com/wallpaper.png"
              />
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => fileRef.current?.click()}
            >
              File...
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <Slider
              label="Image opacity"
              value={Math.round(bg.imageOpacity * 100)}
              min={0}
              max={100}
              onChange={(v) => updateBackground({ imageOpacity: v / 100 })}
              formatValue={(v) => `${v}%`}
            />
            {bg.overlay.kind !== 'none' && (
              <Slider
                label="Overlay intensity"
                value={Math.round(bg.overlay.intensity * 100)}
                min={0}
                max={100}
                onChange={(v) => updateBackground({ overlay: { ...bg.overlay, intensity: v / 100 } })}
                formatValue={(v) => `${v}%`}
              />
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 5 }}>{t('appearance.overlayEffect')}</div>
            <select
              value={bg.overlay.kind}
              onChange={(e) => updateBackground({ overlay: { ...bg.overlay, kind: e.target.value as OverlayKind } })}
              style={{
                width: '100%', padding: '6px 9px',
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text)', fontSize: 'var(--font-sm)',
              }}
            >
              {OVERLAY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          {bg.overlay.kind === 'color' && (
            <div style={{ marginTop: 8 }}>
              <ColorSwatchInput
                label="Tint color"
                value={bg.overlay.color || '#58a6ff'} // lint-allow: hex - user-editable overlay tint default (accent-blue)
                onChange={(v) => updateBackground({ overlay: { ...bg.overlay, color: v } })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
