import { describe, it, expect } from 'vitest';
import { resolveTaskOwnedPaneBadgeCopy } from './taskOwnedPaneBadgeCopy';

// Issue #28 third-party review Important finding: TaskOwnedPaneBadge showed
// "restricted privileges" unconditionally, even in compat mode (scoped
// authorization off, UI token deliberately injected into every task pane) —
// giving a false sense of safety during the migration window.
//
// C案 revision: the color role is inverted — scoped-enabled (the normal,
// expected state) becomes the quiet `neutral`/`lock` styling, and compat
// mode (the state that actually warrants attention) becomes `orange`/
// `warning`.
describe('resolveTaskOwnedPaneBadgeCopy', () => {
  it('uses the enforced-restriction copy, neutral tone, and lock icon when scoped authorization is actually on', () => {
    expect(resolveTaskOwnedPaneBadgeCopy(true)).toEqual({
      labelKey: 'terminal.taskOwnedPaneBadge',
      tooltipKey: 'terminal.taskOwnedPaneTooltip',
      tone: 'neutral',
      icon: 'lock',
    });
  });

  it('uses the compat-mode copy, orange tone, and warning icon when scoped authorization is explicitly off', () => {
    expect(resolveTaskOwnedPaneBadgeCopy(false)).toEqual({
      labelKey: 'terminal.taskOwnedPaneBadgeCompat',
      tooltipKey: 'terminal.taskOwnedPaneTooltipCompat',
      tone: 'orange',
      icon: 'warning',
    });
  });

  it('uses the compat-mode copy, orange tone, and warning icon when the state is not yet known (health not loaded) — unknown must never read as restricted', () => {
    expect(resolveTaskOwnedPaneBadgeCopy(null)).toEqual({
      labelKey: 'terminal.taskOwnedPaneBadgeCompat',
      tooltipKey: 'terminal.taskOwnedPaneTooltipCompat',
      tone: 'orange',
      icon: 'warning',
    });
  });
});
