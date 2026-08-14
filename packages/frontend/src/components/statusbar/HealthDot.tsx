import { useTranslation } from 'react-i18next';
import type { HealthLevel } from '../../hooks/useServerResources';

/**
 * `update` / `active` は accent、`inactive` は既定色（dim）、`off` はドット自体を出さない
 * （稼働検知アイテムの「消灯」— Issue #338）。
 */
export type DotLevel = HealthLevel | 'update' | 'active' | 'inactive' | 'off';

export const HEALTH_COLOR_VAR: Record<DotLevel, string> = {
  healthy: 'var(--success)',
  warning: 'var(--warning)',
  critical: 'var(--danger)',
  update: 'var(--accent)',
  active: 'var(--accent)',
  inactive: 'var(--text-dim)',
  off: 'transparent',
};

/**
 * ヘルスレベル別のチップ（背景/前景）トークン。デスクトップ由来はなく、SP の
 * `ServerHealthSheet`（Issue #69 T6）が使う。
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
  active: 'statusbar.activityEventDriven',
  inactive: 'statusbar.activityFallback',
  off: 'statusbar.activityNone',
};

interface HealthDotProps {
  level: DotLevel;
  size?: number;
}

export function HealthDot({ level, size = 9 }: HealthDotProps) {
  const { t } = useTranslation('common');
  // 消灯（off）は透明の丸を置く: ドットごと消すとラベル位置が他アイテムとずれるため、
  // 面だけを外して場所は保つ。
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
