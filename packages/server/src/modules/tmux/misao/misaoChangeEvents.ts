import type { EventHandler } from '@misao/sdk' with { 'resolution-mode': 'import' };
import type { EventRegistration, MisaoEventSource } from './MisaoConnection';

/** Notifications are coalesced over this window: pane.title fires on every spinner frame of a busy agent. */
export const CHANGE_COALESCE_MS = 200;

const CHANGE_PANE_EVENTS: ReadonlySet<string> = new Set(['pane.opened', 'pane.closed', 'pane.exited', 'pane.title', 'pane.label']);

function isChangeEvent(type: string): boolean {
  return type.startsWith('workspace.') || type.startsWith('window.') || CHANGE_PANE_EVENTS.has(type);
}

/**
 * The misao counterpart of tmux change hooks: one `events.subscribe` stream shared by every installed server,
 * reported as "something changed" (the daemon is global, so every installed server is notified).
 * Subscribing waits for the connection when the daemon is not up yet, and a gap or a recovered subscription counts as a change.
 */
export class MisaoChangeEvents {
  private readonly servers = new Set<string>();
  private subscription: EventRegistration | undefined;
  private subscribing: Promise<void> | undefined;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly source: MisaoEventSource,
    private readonly onChange: (serverName: string) => void,
    private readonly log: { warn(message: string): void },
  ) {
    source.onConnected(() => {
      this.ensureSubscribed().catch((err: unknown) => this.log.warn(`[misao] change event subscription failed: ${err instanceof Error ? err.message : String(err)}`));
    });
    source.onGap(() => this.scheduleNotify());
    source.onEventsRecovered(() => this.scheduleNotify());
  }

  /** Rejects when the daemon is unreachable; the subscription is then made as soon as the connection comes up. */
  async install(serverName: string): Promise<void> {
    this.servers.add(serverName);
    await this.ensureSubscribed();
  }

  uninstall(serverName: string): void {
    this.servers.delete(serverName);
    if (this.servers.size > 0) return;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private ensureSubscribed(): Promise<void> {
    if (this.servers.size === 0 || this.subscription) return Promise.resolve();
    this.subscribing ??= this.source.subscribeEvents(this.handleEvent)
      .then((subscription) => {
        if (this.servers.size === 0) subscription.unsubscribe();
        else this.subscription = subscription;
      })
      .finally(() => { this.subscribing = undefined; });
    return this.subscribing;
  }

  private readonly handleEvent: EventHandler = (event) => {
    if (isChangeEvent(event.type)) this.scheduleNotify();
  };

  private scheduleNotify(): void {
    if (this.servers.size === 0 || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      for (const serverName of this.servers) this.onChange(serverName);
    }, CHANGE_COALESCE_MS);
    this.flushTimer.unref();
  }
}
