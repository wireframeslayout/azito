import type { MuxPaneProcessState } from '@azito/shared';

interface PaneWithState {
  processState?: MuxPaneProcessState;
}

interface WindowWithPanes {
  panes: readonly PaneWithState[];
}

/** Why the terminal cannot show a pane (terminal WS close codes 4410 / 4412 / 4413, or the pane vanishing from the window list). */
export type PaneUnavailableReason = 'pane_stopped' | 'window_empty' | 'pane_closed';

export type PaneNoticeAction = 'resume' | 'delete_pane' | 'open_pane' | 'kill_window' | 'open_first_pane' | 'close_tab';

/**
 * The ways out the notice offers, in display order. `canResume` is true for a task's window, whose agent can be
 * brought back with its conversation; a hand-made window only offers deleting the stopped pane.
 */
export function paneNoticeActions(reason: PaneUnavailableReason, canResume: boolean): PaneNoticeAction[] {
  switch (reason) {
    case 'pane_stopped': return canResume ? ['resume', 'delete_pane'] : ['delete_pane'];
    case 'window_empty': return ['open_pane', 'kill_window'];
    case 'pane_closed': return ['open_first_pane', 'close_tab'];
  }
}

/**
 * What a window that is listed but lacks the terminal's pane means. A misao pane that is gone is a closed pane (its
 * terminal must not silently move to whichever pane took its number); for tmux it stays a missing target.
 */
export function missingPaneOutcome(muxKind: string | undefined): 'pane_closed' | 'window_missing' {
  return muxKind === 'misao' ? 'pane_closed' : 'window_missing';
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
 * The 1-based pane ordinal to attach when a window is opened without naming one: the first running pane, else the
 * first pane. It is the pane's position, not its `index` (tmux's pane-base-index may make `index` start at 0).
 * null for a window with no panes.
 */
export function preferredPaneOrdinal(win: WindowWithPanes): number | null {
  if (win.panes.length === 0) return null;
  const running = win.panes.findIndex((p) => p.processState === 'running');
  return (running === -1 ? 0 : running) + 1;
}
