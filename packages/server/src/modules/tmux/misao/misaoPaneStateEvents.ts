import type { EventHandler } from '@misao/sdk' with { 'resolution-mode': 'import' };
import type { EventRegistration, MisaoDisconnectSource, MisaoEventSource, MisaoRpc } from './MisaoConnection';
import { sortPanes, type MisaoPane } from './misaoMapping';

export interface MisaoPaneState {
  paneId: string;
  /** The daemon's agent state; an unrecognised value is passed through as received. */
  state: string;
  /** The daemon's deciding rule: exit / a profile name / title / bytes / none. */
  decidedBy: string;
  /** Where the pane lives, known when the state comes from a full pane list (re-sync) rather than an event. */
  location?: MisaoPaneLocation;
}

export interface MisaoPaneLocation {
  workspace: string;
  windowId: string;
  /** 1-based position of the pane in its window (pane id order), as `MisaoMuxClient` numbers panes. */
  ordinal: number;
}

/** Receives the daemon's pane states: single changes, full re-syncs (every pane the daemon knows), and connection loss. */
export interface MisaoPaneStateReceiver {
  handleState(state: MisaoPaneState): void;
  handleSnapshot(states: MisaoPaneState[]): void;
  handleDisconnected(): void;
}

export type MisaoPaneStateSource = MisaoEventSource & MisaoDisconnectSource & Pick<MisaoRpc, 'request'>;

function readPaneState(event: Parameters<EventHandler>[0]): MisaoPaneState | undefined {
  if (event.type !== 'pane.state' || typeof event.paneId !== 'string') return undefined;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const { state, decidedBy } = data as { state?: unknown; decidedBy?: unknown };
  if (typeof state !== 'string' || typeof decidedBy !== 'string') return undefined;
  return { paneId: event.paneId, state, decidedBy };
}

/** Pane ids are ULIDs, so id order within a window is creation order — the ordinal `MisaoMuxClient` uses. */
function toSnapshot(panes: readonly MisaoPane[]): MisaoPaneState[] {
  const nextOrdinal = new Map<string, number>();
  return sortPanes(panes).map((pane) => {
    const ordinal = (nextOrdinal.get(pane.window.id) ?? 0) + 1;
    nextOrdinal.set(pane.window.id, ordinal);
    return {
      paneId: pane.paneId,
      state: pane.agentState,
      decidedBy: pane.decidedBy,
      location: { workspace: pane.workspace, windowId: pane.window.id, ordinal },
    };
  });
}

/**
 * Reports the daemon's `pane.state` events (activity detection) for every pane. The event stream only carries
 * changes, so the full pane list is re-read on every (re)connect and gap to bring the receiver back in sync.
 */
export class MisaoPaneStateEvents {
  private subscription: EventRegistration | undefined;
  private subscribing: Promise<void> | undefined;
  private stopListening: Array<() => void> = [];
  private started = false;

  constructor(
    private readonly source: MisaoPaneStateSource,
    private readonly receiver: MisaoPaneStateReceiver,
    private readonly log: { warn(message: string): void },
  ) {}

  /** Rejects when the daemon is unreachable; the subscription and a full re-sync then happen as soon as the connection comes up. */
  async start(): Promise<void> {
    if (this.started) throw new Error('MisaoPaneStateEvents already started');
    this.started = true;
    this.stopListening = [
      this.source.onConnected(() => { this.syncAll(true); }),
      this.source.onGap(() => { this.syncAll(false); }),
      this.source.onDisconnected(() => this.receiver.handleDisconnected()),
    ];
    await this.ensureSubscribed();
    await this.resync();
  }

  stop(): void {
    this.started = false;
    for (const off of this.stopListening) off();
    this.stopListening = [];
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private syncAll(subscribeFirst: boolean): void {
    const run = subscribeFirst ? this.ensureSubscribed().then(() => this.resync()) : this.resync();
    run.catch((err: unknown) => this.log.warn(`[misao] pane state sync failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private ensureSubscribed(): Promise<void> {
    if (!this.started || this.subscription) return Promise.resolve();
    this.subscribing ??= this.source.subscribeEvents(this.handleEvent)
      .then((subscription) => {
        if (this.started) this.subscription = subscription;
        else subscription.unsubscribe();
      })
      .finally(() => { this.subscribing = undefined; });
    return this.subscribing;
  }

  private async resync(): Promise<void> {
    const panes = await this.source.request('pane.list', {});
    if (!this.started) return;
    this.receiver.handleSnapshot(toSnapshot(panes));
  }

  private readonly handleEvent: EventHandler = (event) => {
    const paneState = readPaneState(event);
    if (paneState) this.receiver.handleState(paneState);
  };
}
