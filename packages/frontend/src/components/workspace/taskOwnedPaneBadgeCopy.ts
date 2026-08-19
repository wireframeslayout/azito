import type { BadgeTone } from '../ui/Badge';
import type { IconName } from '../ui/Icon';

export interface TaskOwnedPaneBadgeCopyKeys {
  labelKey: 'terminal.taskOwnedPaneBadge' | 'terminal.taskOwnedPaneBadgeCompat';
  tooltipKey: 'terminal.taskOwnedPaneTooltip' | 'terminal.taskOwnedPaneTooltipCompat';
  tone: BadgeTone;
  icon: IconName;
}

/**
 * Selects which i18n keys, tone, and icon TaskOwnedPaneBadge renders, given
 * the hub's current scoped-authorization state (Issue #28 third-party review
 * Important finding; C案 revision). Extracted as a pure function so the
 * branching itself — not just the component wiring — is directly testable
 * (matches this codebase's convention of pulling presentational logic out of
 * components that have no React component test harness; see paneTabOverlay.ts).
 *
 * `scopedAuthEnabled === true`: enforcement is actually on — this is the
 * normal, expected state, so it gets the quiet `neutral` tone / `lock` icon
 * and the short label.
 * `scopedAuthEnabled === false OR null` (off, or GET /api/health hasn't
 * resolved yet): compat mode — "unknown" must never read as "restricted"
 * when it might not be, since a UI token is deliberately injected into every
 * task pane's env while scoped auth is off. This is the state that actually
 * warrants attention, so it keeps the `orange` tone but switches to the
 * `warning` icon (previously both states shared `orange`/`lock`, burying the
 * one case operators need to notice).
 */
export function resolveTaskOwnedPaneBadgeCopy(scopedAuthEnabled: boolean | null): TaskOwnedPaneBadgeCopyKeys {
  if (scopedAuthEnabled) {
    return {
      labelKey: 'terminal.taskOwnedPaneBadge',
      tooltipKey: 'terminal.taskOwnedPaneTooltip',
      tone: 'neutral',
      icon: 'lock',
    };
  }
  return {
    labelKey: 'terminal.taskOwnedPaneBadgeCompat',
    tooltipKey: 'terminal.taskOwnedPaneTooltipCompat',
    tone: 'orange',
    icon: 'warning',
  };
}
