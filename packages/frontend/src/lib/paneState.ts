import type { MuxPaneProcessState } from '@azito/shared';

interface PaneWithState {
  processState?: MuxPaneProcessState;
}

interface WindowWithPanes<P extends PaneWithState> {
  panes: Array<P & { index: number }>;
}

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
 * The pane to attach when a window is opened without naming one: the first running pane, else the first pane.
 * null for a window with no panes.
 */
export function preferredPaneOrdinal<P extends PaneWithState>(win: WindowWithPanes<P>): number | null {
  const running = win.panes.find((p) => p.processState === 'running');
  const chosen = running ?? win.panes[0];
  return chosen ? chosen.index : null;
}
