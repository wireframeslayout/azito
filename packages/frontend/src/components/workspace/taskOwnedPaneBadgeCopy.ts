export interface TaskOwnedPaneBadgeCopyKeys {
  labelKey: 'terminal.taskOwnedPaneBadge' | 'terminal.taskOwnedPaneBadgeCompat';
  tooltipKey: 'terminal.taskOwnedPaneTooltip' | 'terminal.taskOwnedPaneTooltipCompat';
}

/**
 * Selects which i18n keys TaskOwnedPaneBadge renders, given the hub's
 * current scoped-authorization state (Issue #28 third-party review
 * Important finding). Extracted as a pure function so the branching itself
 * — not just the component wiring — is directly testable (matches this
 * codebase's convention of pulling presentational logic out of components
 * that have no React component test harness; see paneTabOverlay.ts).
 *
 * `scopedAuthEnabled === true`: enforcement is actually on — the
 * "restricted privileges" wording is true.
 * `scopedAuthEnabled === false OR null` (off, or GET /api/health hasn't
 * resolved yet): compat-mode wording — "unknown" must never read as
 * "restricted" when it might not be, since a UI token is deliberately
 * injected into every task pane's env while scoped auth is off.
 */
export function resolveTaskOwnedPaneBadgeCopy(scopedAuthEnabled: boolean | null): TaskOwnedPaneBadgeCopyKeys {
  if (scopedAuthEnabled) {
    return { labelKey: 'terminal.taskOwnedPaneBadge', tooltipKey: 'terminal.taskOwnedPaneTooltip' };
  }
  return { labelKey: 'terminal.taskOwnedPaneBadgeCompat', tooltipKey: 'terminal.taskOwnedPaneTooltipCompat' };
}
