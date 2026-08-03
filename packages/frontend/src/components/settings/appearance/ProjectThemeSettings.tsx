import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { useTerminalTheme } from '../../../hooks/useTerminalTheme';
import { PRESET_THEMES } from '../../../themes/presets';
import { LoadingState } from '../../ui';

interface ProjectItem {
  id: number;
  name: string;
}

export default function ProjectThemeSettings() {
  const { t } = useTranslation('settings');
  const { store, setProjectOverride } = useTerminalTheme();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<ProjectItem[]>('/projects')
      .then((data) => {
        if (Array.isArray(data)) setProjects(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
        <LoadingState />
      </div>
    );
  }

  if (projects.length === 0) return null;

  const allThemes = [
    ...PRESET_THEMES.map((p) => ({ id: p.id, name: p.name, isCustom: false })),
    ...Object.entries(store.customThemes).map(([id, t]) => ({ id, name: t.name, isCustom: true })),
  ];

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
      <div style={{ fontSize: 'var(--font-md)', fontWeight: 650, marginBottom: 2 }}>{t('appearance.projectThemes')}</div>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginBottom: 12 }}>
        {t('appearance.projectThemesDescription')}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {projects.map((project) => (
          <div key={project.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              flex: 1, fontSize: 'var(--font-sm)',
              fontFamily: "'JetBrainsMono Nerd Font', monospace",
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {project.name}
            </span>
            <select
              value={store.projectOverrides[String(project.id)] || ''}
              onChange={(e) => setProjectOverride(String(project.id), e.target.value || null)}
              aria-label={`${project.name} theme`}
              style={{
                width: 220, padding: '6px 9px',
                background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-sm)',
              }}
            >
              <option value="">{t('common:labels.default')}</option>
              {allThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.isCustom ? ' (custom)' : ''}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
