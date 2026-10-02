import { asPaneHandle } from '@azito/shared';
import type { MisaoPaneState } from '../tmux/misao/misaoPaneStateEvents';
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
  monitor: { recordMuxSignal(serverName: string, target: string, status: MuxAgentStatus, detail?: { decidedBy?: string }): void };
  /** The local servers running the misao mux, read at use time (servers can be added while the hub runs). */
  listServerNames: () => string[];
  log: { warn(message: string): void };
  now?: () => number;
}

/**
 * Feeds the misao daemon's per-pane agent state into AgentActivityMonitor's Tier 0 mux path. The daemon is
 * global, so a pane is attributed to the first misao server whose window table knows it; only a window's
 * first pane counts, so a shell pane split next to the agent never overwrites the agent's state.
 */
export class MisaoActivityBridge {
  /** The newest state per pane that has not been attributed yet; resolution is async, so it is read after resolving. */
  private readonly latest = new Map<string, MisaoPaneState>();
  private readonly unresolvedSince = new Map<string, number>();
  private readonly recorded = new Map<string, { serverName: string; target: string }>();

  constructor(private readonly deps: MisaoActivityBridgeDeps) {}

  handleState(state: MisaoPaneState): void {
    this.latest.set(state.paneId, state);
    this.attribute(state.paneId).catch((err: unknown) => this.warn(state.paneId, err));
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
      this.attribute(paneId).catch((err: unknown) => this.warn(paneId, err));
    }
  }

  /** Nothing is known about the panes while the daemon is away; the re-sync on reconnect restores them. */
  handleDisconnected(): void {
    for (const { serverName, target } of this.recorded.values()) {
      this.deps.monitor.recordMuxSignal(serverName, target, 'unknown');
    }
    this.recorded.clear();
  }

  private async attribute(paneId: string): Promise<void> {
    const handle = asPaneHandle(paneId);
    for (const serverName of this.deps.listServerNames()) {
      const resolved = await this.deps.resolver.resolveWindowByPaneHandle(serverName, handle);
      if (!resolved) continue;
      this.unresolvedSince.delete(paneId);
      const state = this.latest.get(paneId);
      if (!state) return;
      this.latest.delete(paneId);
      if (resolved.ordinal !== 1) return;
      this.deps.monitor.recordMuxSignal(serverName, resolved.tmuxTarget, mapMisaoAgentState(state.state), { decidedBy: state.decidedBy });
      if (state.state === 'exited') this.recorded.delete(paneId);
      else this.recorded.set(paneId, { serverName, target: resolved.tmuxTarget });
      return;
    }
    if (this.latest.get(paneId)?.state === 'exited') {
      this.latest.delete(paneId);
      this.unresolvedSince.delete(paneId);
    } else if (this.latest.has(paneId) && !this.unresolvedSince.has(paneId)) {
      this.unresolvedSince.set(paneId, this.now());
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private warn(paneId: string, err: unknown): void {
    this.deps.log.warn(`[misao] could not attribute the state of pane ${paneId} to a window: ${err instanceof Error ? err.message : String(err)}`);
  }
}
