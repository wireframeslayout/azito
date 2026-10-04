import { stripPaneSuffix, type MuxRef } from '@azito/shared';
import type { Session, TmuxWindow, Window } from '../pages/workspace/types';
import { findSessionWindow } from './windowMatch';

type PlannableWindow = Pick<Window, 'id' | 'tmuxTarget' | 'label' | 'muxRef' | 'sleeping'>;

export interface PlannedPane {
  index: number;
  /** Target handed to the row's click / active / focus checks: the DB target with this pane's number. */
  target: string;
  /** The tmux pane target a context-menu action (rename pane, ...) addresses. */
  menuPaneTarget: string;
}

interface PlannedOnlineRow {
  session: Session;
  window: TmuxWindow;
  /** Window name (or index when the name is ambiguous in the session) used by window-level actions. */
  windowSpec: string;
  /** The DB target without a pane suffix. */
  baseTarget: string;
  panes: PlannedPane[];
  /** Target a click on the row addresses (a window row without panes opens the terminal's pane notice at pane 1). */
  clickTarget: string;
  /** The window's session was kept from an earlier listing: its mux cannot be listed now (see keepUnavailableKinds). */
  stale: boolean;
}

/**
 * Which kind of row a registered window gets in the window tree, and the targets it uses.
 * - sleeping: shown as a sleeping row
 * - offline: no session window matched
 * - empty: matched, but the window has no panes (misao keeps a window after its last pane closed)
 * - single: matched, one pane — one row
 * - multi: matched, several panes — a window row with expandable pane rows
 */
export type WindowRowPlan =
  | { kind: 'sleeping' }
  | { kind: 'offline' }
  | ({ kind: 'empty' | 'single' | 'multi' } & PlannedOnlineRow);

export function planWindowRow(w: PlannableWindow, sessions: Session[]): WindowRowPlan {
  if (w.sleeping) return { kind: 'sleeping' };
  const match = findSessionWindow(w, sessions);
  if (!match) return { kind: 'offline' };

  const { session, window: sw } = match;
  const baseTarget = stripPaneSuffix(w.tmuxTarget);
  const windowSpec = session.windows.filter((other) => other.name === sw.name).length === 1 ? sw.name : String(sw.index);
  const panes = sw.panes.map((pane) => ({
    index: pane.index,
    target: `${baseTarget}.${pane.index}`,
    menuPaneTarget: `${session.name}:${windowSpec}.${pane.index}`,
  }));
  const kind = panes.length === 0 ? 'empty' : panes.length === 1 ? 'single' : 'multi';
  const clickTarget = kind === 'multi' ? baseTarget : (panes[0]?.target ?? `${baseTarget}.1`);
  return { kind, session, window: sw, windowSpec, baseTarget, panes, clickTarget, stale: session.stale === true };
}

/**
 * Whether a window can be acted on through its mux now (add / split / delete a window or pane, pane actions). A stale
 * row's mux cannot be reached; opening its existing tab is still allowed.
 */
export function canActOnMux(row: { stale?: boolean } | undefined): boolean {
  return row?.stale !== true;
}

/** misao cannot set a pane title (the hub answers 501), so the rename-pane action is only offered for other windows. */
export function canRenamePane(w: { muxRef?: MuxRef }): boolean {
  return w.muxRef?.kind !== 'misao';
}
