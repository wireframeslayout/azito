import type { MuxPaneProcessState } from '@azito/shared';

interface PaneWithState {
  processState?: MuxPaneProcessState;
}

interface WindowWithPanes {
  panes: readonly PaneWithState[];
}

/** Why the hub refused to attach a pane (terminal WS close codes 4410 / 4412). */
export type PaneUnavailableReason = 'pane_stopped' | 'window_empty';

export type PaneStateChip = 'stopped' | 'exited';

/**
 * A pane counts as live unless the driver says otherwise. `processState` is only reported by misao; a pane
 * without it (tmux) is live, and `unknown` is not evidence of a stopped process, so it stays live too.
 */
export function isPaneLive(pane: PaneWithState): boolean {
  return pane.processState !== 'stopped' && pane.processState !== 'exited';
}

/** Which state chip a pane row shows, or null for a live pane. */
export function paneStateChip(pane: PaneWithState): PaneStateChip | null {
  return pane.processState === 'stopped' || pane.processState === 'exited' ? pane.processState : null;
}

/**
 * The 1-based pane ordinal to attach when a window is opened without naming one: the first running pane, else the
 * first pane. It is the pane's position, not its `index` (tmux's pane-base-index may make `index` start at 0).
 * null for a window with no panes.
 */
export function preferredPaneOrdinal(win: WindowWithPanes): number | null {
  if (win.panes.length === 0) return null;
  const running = win.panes.findIndex((p) => p.processState === 'running');
  return (running === -1 ? 0 : running) + 1;
}
