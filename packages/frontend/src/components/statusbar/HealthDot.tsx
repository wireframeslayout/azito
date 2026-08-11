import { useTranslation } from 'react-i18next';
import type { HealthLevel } from '../../hooks/useServerResources';

export type DotLevel = HealthLevel | 'update';

export const HEALTH_COLOR_VAR: Record<DotLevel, string> = {
  healthy: 'var(--success)',
  warning: 'var(--warning)',
  critical: 'var(--danger)',
  update: 'var(--accent)',
};

/**
 * ヘルスレベル別のチップ（背景/前景）トークン。デスクトップ由来はなく、SP の
 * `ServerHealthSheet`（Issue #69 T6）と `FloatingActivityPill` のヘルス節（Issue #338 T11 P1）が
 * 共有する（コピー禁止）。
 */
export const HEALTH_CHIP_TOKENS: Record<HealthLevel, { bg: string; fg: string }> = {
  healthy: { bg: 'var(--success-a15)', fg: 'var(--success)' },
  warning: { bg: 'var(--warning-a15)', fg: 'var(--warning)' },
  critical: { bg: 'var(--danger-a15)', fg: 'var(--danger)' },
};

const DOT_LABEL_KEY: Record<DotLevel, string> = {
  healthy: 'statusbar.healthy',
  warning: 'statusbar.warning',
  critical: 'statusbar.critical',
  update: 'statusbar.updateAvailable',
};

interface HealthDotProps {
  level: DotLevel;
  size?: number;
}

export function HealthDot({ level, size = 9 }: HealthDotProps) {
  const { t } = useTranslation('common');
  return (
    <span
      aria-label={t(DOT_LABEL_KEY[level])}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: HEALTH_COLOR_VAR[level],
        flexShrink: 0,
      }}
    />
  );
}
