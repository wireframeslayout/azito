import { asPaneHandle, type MuxRef } from '@azito/shared';
import type { MisaoPaneLocation, MisaoPaneState, MisaoPaneStateReceiver } from '../tmux/misao/misaoPaneStateEvents';
import { misaoRef } from '../tmux/misao/misaoMapping';
import type { MuxAgentStatus } from './AgentActivityMonitor';
import type { PaneHandleResolver } from './PaneHandleResolver';

/** How long a pane that belongs to no registered window keeps being re-resolved on window list changes. */
export const UNRESOLVED_PANE_TTL_MS = 60_000;

/** The daemon's `exited` is a finished session, which the monitor's mux path reports as `done`. */
export function mapMisaoAgentState(state: string): MuxAgentStatus {
  switch (state) {
    case 'working': return 'working';
    case 'blocked': return 'blocked';
    case 'idle': return 'idle';
    case 'exited': return 'done';
    default: return 'unknown';
  }
}

export interface MisaoActivityBridgeDeps {
  resolver: Pick<PaneHandleResolver, 'resolveWindowByPaneHandle'>;
  /** The registered window behind a misao ref, for states that already carry their pane's location (re-sync). */
  findWindowByRef: (serverName: string, ref: MuxRef) => { tmuxTarget: string } | undefined;
  monitor: { recordMuxSignal(serverName: string, target: string, status: MuxAgentStatus, detail?: { decidedBy?: string }): void };
  /** The local servers running the misao mux, read at use time (servers can be added while the hub runs). */
  listServerNames: () => string[];
  log: { warn(message: string): void };
  now?: () => number;
}

interface PaneOwner {
  serverName: string;
  tmuxTarget: string;
  ordinal: number;
}

/**
 * Feeds the misao daemon's per-pane agent state into AgentActivityMonitor's Tier 0 mux path. The daemon is
 * global, so a pane is attributed to the first misao server whose window table knows it; only a window's
 * first pane counts, so a shell pane split next to the agent never overwrites the agent's state.
 */
export class MisaoActivityBridge implements MisaoPaneStateReceiver {
  /** The newest state per pane that has not been attributed yet; resolution is async, so it is read after resolving. */
  private readonly latest = new Map<string, MisaoPaneState>();
  private readonly unresolvedSince = new Map<string, number>();
  private readonly recorded = new Map<string, { serverName: string; target: string }>();

  constructor(private readonly deps: MisaoActivityBridgeDeps) {}

  handleState(state: MisaoPaneState): void {
    this.latest.set(state.paneId, state);
    this.attributeLogged(state.paneId);
  }

  /** Every pane the daemon knows: a recorded pane missing from it was closed, so its window is released. */
  handleSnapshot(states: MisaoPaneState[]): void {
    const present = new Set(states.map((s) => s.paneId));
    for (const [paneId, { serverName, target }] of [...this.recorded]) {
      if (present.has(paneId)) continue;
      this.recorded.delete(paneId);
      this.deps.monitor.recordMuxSignal(serverName, target, 'unknown');
    }
    for (const paneId of [...this.unresolvedSince.keys()]) {
      if (present.has(paneId)) continue;
      this.unresolvedSince.delete(paneId);
      this.latest.delete(paneId);
    }
    for (const state of states) this.handleState(state);
  }

  /** Window rows may be registered after the daemon already reported their pane: try the unresolved panes again. */
  handleWindowsChanged(): void {
    const now = this.now();
    for (const [paneId, since] of [...this.unresolvedSince]) {
      if (now - since > UNRESOLVED_PANE_TTL_MS) {
        this.unresolvedSince.delete(paneId);
        this.latest.delete(paneId);
        continue;
      }
      this.attributeLogged(paneId);
    }
  }

  /** Nothing is known about the panes while the daemon is away; the re-sync on reconnect restores them. */
  handleDisconnected(): void {
    for (const { serverName, target } of this.recorded.values()) {
      this.deps.monitor.recordMuxSignal(serverName, target, 'unknown');
    }
    this.recorded.clear();
  }

  /** A failed attempt forgets the state it was attributing, unless a newer one has arrived since (its own attempt is pending). */
  private attributeLogged(paneId: string): void {
    const pending = this.latest.get(paneId);
    this.attribute(paneId).catch((err: unknown) => {
      if (this.latest.get(paneId) === pending) {
        this.latest.delete(paneId);
        this.unresolvedSince.delete(paneId);
      }
      this.deps.log.warn(`[misao] could not attribute the state of pane ${paneId} to a window: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async attribute(paneId: string): Promise<void> {
    const owner = await this.findOwner(paneId, this.latest.get(paneId)?.location);
    const state = this.latest.get(paneId);
    if (!owner) {
      // A window row that is gone takes its mux state with it (the monitor drops keys without a row).
      this.recorded.delete(paneId);
      if (state?.state === 'exited') {
        this.latest.delete(paneId);
        this.unresolvedSince.delete(paneId);
      } else if (state && !this.unresolvedSince.has(paneId)) {
        this.unresolvedSince.set(paneId, this.now());
      }
      return;
    }
    this.unresolvedSince.delete(paneId);
    if (!state) return;
    this.latest.delete(paneId);
    if (owner.ordinal !== 1) return;
    this.deps.monitor.recordMuxSignal(owner.serverName, owner.tmuxTarget, mapMisaoAgentState(state.state), { decidedBy: state.decidedBy });
    if (state.state === 'exited') this.recorded.delete(paneId);
    else this.recorded.set(paneId, { serverName: owner.serverName, target: owner.tmuxTarget });
  }

  /** A located state (re-sync) is matched against the window table directly; an event asks the daemon where the pane is. */
  private async findOwner(paneId: string, location: MisaoPaneLocation | undefined): Promise<PaneOwner | null> {
    for (const serverName of this.deps.listServerNames()) {
      if (location) {
        const win = this.deps.findWindowByRef(serverName, misaoRef(location.workspace, location.windowId));
        if (win) return { serverName, tmuxTarget: win.tmuxTarget, ordinal: location.ordinal };
        continue;
      }
      const resolved = await this.deps.resolver.resolveWindowByPaneHandle(serverName, asPaneHandle(paneId));
      if (resolved) return { serverName, tmuxTarget: resolved.tmuxTarget, ordinal: resolved.ordinal };
    }
    return null;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
