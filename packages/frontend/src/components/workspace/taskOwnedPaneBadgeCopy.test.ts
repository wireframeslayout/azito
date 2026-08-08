import { describe, it, expect } from 'vitest';
import { resolveTaskOwnedPaneBadgeCopy } from './taskOwnedPaneBadgeCopy';

// Issue #28 third-party review Important finding: TaskOwnedPaneBadge showed
// "restricted privileges" unconditionally, even in compat mode (scoped
// authorization off, UI token deliberately injected into every task pane) —
// giving a false sense of safety during the migration window.
describe('resolveTaskOwnedPaneBadgeCopy', () => {
  it('uses the enforced-restriction copy when scoped authorization is actually on', () => {
    expect(resolveTaskOwnedPaneBadgeCopy(true)).toEqual({
      labelKey: 'terminal.taskOwnedPaneBadge',
      tooltipKey: 'terminal.taskOwnedPaneTooltip',
    });
  });

  it('uses the compat-mode copy when scoped authorization is explicitly off', () => {
    expect(resolveTaskOwnedPaneBadgeCopy(false)).toEqual({
      labelKey: 'terminal.taskOwnedPaneBadgeCompat',
      tooltipKey: 'terminal.taskOwnedPaneTooltipCompat',
    });
  });

  it('uses the compat-mode copy when the state is not yet known (health not loaded) — unknown must never read as restricted', () => {
    expect(resolveTaskOwnedPaneBadgeCopy(null)).toEqual({
      labelKey: 'terminal.taskOwnedPaneBadgeCompat',
      tooltipKey: 'terminal.taskOwnedPaneTooltipCompat',
    });
  });
});
