import { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalTheme } from '../../../hooks/useTerminalTheme';
import { ansiToHtml } from '../../../utils/ansi';
import { syncPushLanguage } from '../../../utils/pushNotifications';
import type { DesignMode } from '../../../themes/types';
import ThemePresetGallery from './ThemePresetGallery';
import PaletteEditor from './PaletteEditor';
import BackgroundSettingsEditor, { SegmentedControl } from './BackgroundSettingsEditor';
import ProjectThemeSettings from './ProjectThemeSettings';

const DESIGN_OPTIONS: { value: DesignMode; label: string }[] = [
  { value: 'shade', label: 'Shade' },
  { value: 'wired', label: 'Wired' },
];

const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
];

const SAMPLE_ANSI = [
  '\x1b[32m➜\x1b[0m \x1b[36m~/workspace/azito\x1b[0m \x1b[90m(main)\x1b[0m',
  '$ npm run dev',
  '\x1b[90m[server]\x1b[0m \x1b[32m✓\x1b[0m Fastify listening on \x1b[34m:3001\x1b[0m',
  '\x1b[90m[web]\x1b[0m \x1b[35mVITE\x1b[0m ready in \x1b[33m432 ms\x1b[0m',
  '\x1b[32;1m✓\x1b[0m implementing done \x1b[90m— 3 files\x1b[0m',
  '\x1b[31;1m✗\x1b[0m vitest: 1 failed \x1b[36m→ retry\x1b[0m',
  '$ \x1b[7m \x1b[0m',
].join('\n');

export default function AppearanceSection() {
  const { t, i18n } = useTranslation('settings');
  const { ansiPalette, backdrop, resolvedTheme, design, setDesign } = useTerminalTheme();
  const [storageError, setStorageError] = useState(false);

  const previewHtml = useMemo(() => ansiToHtml(SAMPLE_ANSI, ansiPalette), [ansiPalette]);

  const handleLanguageChange = useCallback((lng: string) => {
    setStorageError(false);
    i18n.changeLanguage(lng).then(() => {
      try {
        localStorage.getItem('azito-language');
      } catch {
        setStorageError(true);
      }
      syncPushLanguage(lng).catch(() => {});
    });
  }, [i18n]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Preview */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
        <div style={{ fontSize: 'var(--font-md)', fontWeight: 650, marginBottom: 2 }}>{t('appearance.preview')}</div>
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
          {t('appearance.previewDescription')}
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            borderBottom: '1px solid var(--border)', background: 'var(--bg)',
            fontSize: 'var(--font-xs)', color: 'var(--text-dim)', fontFamily: "'JetBrainsMono Nerd Font', monospace",
          }}>
            azito — preview
            <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>{resolvedTheme.name}</span>
          </div>
          <div style={{ position: 'relative', height: 200, overflow: 'hidden', background: ansiPalette.background }}>
            {backdrop.mode !== 'none' && backdrop.scope === 'terminal' && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, background: backdrop.baseCss }} />
                {backdrop.imageUrl && (
                  <div style={{
                    position: 'absolute', inset: backdrop.imageBlur ? -12 : 0,
                    backgroundImage: `url(${backdrop.imageUrl})`, backgroundSize: 'cover',
                    backgroundPosition: 'center', opacity: backdrop.imageOpacity,
                    filter: backdrop.imageBlur ? `blur(${backdrop.blurIntensity * 12}px)` : undefined,
                    transform: backdrop.imageBlur ? 'scale(1.06)' : undefined,
                  }} />
                )}
                {backdrop.overlayCss && <div style={{ position: 'absolute', inset: 0, background: backdrop.overlayCss }} />}
              </div>
            )}
            <pre
              dangerouslySetInnerHTML={{ __html: previewHtml }}
              style={{
                position: 'relative', zIndex: 1,
                fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
                fontSize: 'var(--font-xs)', lineHeight: 1.7, whiteSpace: 'pre-wrap',
                color: ansiPalette.foreground, padding: '10px 12px', margin: 0,
                background: 'transparent', overflow: 'hidden', height: '100%',
              }}
            />
          </div>
        </div>
      </div>

      {/* Design mode */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
        <div style={{ fontSize: 'var(--font-md)', fontWeight: 650, marginBottom: 2 }}>{t('appearance.designMode')}</div>
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
          {t('appearance.designModeDescription')}
        </div>
        <SegmentedControl
          options={DESIGN_OPTIONS}
          value={design}
          onChange={setDesign}
          label={t('appearance.designMode')}
        />
      </div>

      {/* Language */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
        <div style={{ fontSize: 'var(--font-md)', fontWeight: 650, marginBottom: 2 }}>{t('appearance.language')}</div>
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
          {t('appearance.languageDescription')}
        </div>
        <SegmentedControl
          options={LANGUAGE_OPTIONS}
          value={i18n.language}
          onChange={handleLanguageChange}
          label={t('appearance.language')}
        />
        {storageError && (
          <div
            role="status"
            aria-live="polite"
            style={{ fontSize: 'var(--font-sm)', color: 'var(--warning)', marginTop: 8 }}
          >
            {t('appearance.storageFailed')}
          </div>
        )}
      </div>

      <ThemePresetGallery />
      <BackgroundSettingsEditor />
      <PaletteEditor />
      <ProjectThemeSettings />
    </div>
  );
}
