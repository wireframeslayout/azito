import type { MisaoClient, EventHandler, LineHandler, GapInfo, Subscription, SubscriptionErrorInfo, ConnectionState } from '@misao/sdk' with { 'resolution-mode': 'import' };
import type { MethodName, MethodParams, MethodResult } from '@misao/protocol' with { 'resolution-mode': 'import' };
import type { MuxDriverAvailability } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';

// @misao/sdk is ESM-only while the server compiles to CJS: types come via resolution-mode, values via dynamic import().
export type MisaoSdk = typeof import('@misao/sdk', { with: { 'resolution-mode': 'import' } });

export interface MisaoRpc {
  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** The daemon's error code when `err` is an RPC error response, otherwise undefined. */
  rpcErrorCode(err: unknown): number | undefined;
  /** True when `err` means the daemon connection is down (as opposed to an error response). */
  isConnectionError(err: unknown): boolean;
}

/** What a terminal needs from its own daemon connection: attach is per connection, so each terminal owns one. */
export type MisaoAttachClient = Pick<MisaoClient, 'request' | 'subscribeEvents' | 'onNotification' | 'onStateChange' | 'close'>;

/** What a consumer holds for an events registration: the shared SDK subscription is not its to manage. */
export interface EventRegistration {
  unsubscribe(): void;
}

export interface MisaoEventSource {
  subscribeEvents(handler: EventHandler): Promise<EventRegistration>;
  onGap(listener: (gap: GapInfo) => void): () => void;
  /** Fires when the events subscription is back after a period without one (events in between were not delivered), like a gap. */
  onEventsRecovered(listener: () => void): () => void;
  /** Fires on every transition into the connected state (first connect, retry success, SDK reconnect). */
  onConnected(listener: () => void): () => void;
}

export interface MisaoDisconnectSource {
  /** Fires once when a connected daemon connection is lost (not on each failed reconnect attempt). */
  onDisconnected(listener: () => void): () => void;
}

/** Per-pane line stream. The SDK re-subscribes after a reconnect; a re-subscribe the daemon refuses is reported through onSubscriptionError. */
export interface MisaoLineSource {
  subscribeLines(paneId: string, handler: LineHandler): Promise<Subscription>;
  onGap(listener: (gap: GapInfo) => void): () => void;
  onSubscriptionError(listener: (info: SubscriptionErrorInfo) => void): () => void;
}

export interface MisaoConnectionOptions {
  socketPath: string;
  sdk: MisaoSdk;
  log: { warn(message: string): void };
}

type Status = 'idle' | 'connected' | 'disconnected' | 'closed';

/**
 * The hub's single connection to the misao daemon. The SDK retries only after a first successful connect,
 * so the first connect is retried here with the SDK's own backoff until it succeeds or the connection is closed.
 */
export class MisaoConnection implements MisaoRpc, MisaoEventSource, MisaoDisconnectSource, MisaoLineSource {
  private client: MisaoClient | undefined;
  private status: Status = 'idle';
  private retryTimer: NodeJS.Timeout | undefined;
  /** One entry per registration, so registering the same function twice stays two independent registrations. */
  private readonly eventHandlers = new Set<{ handler: EventHandler }>();
  private eventSubscription: Subscription | undefined;
  private eventSubscribing: Promise<void> | undefined;
  private eventRetryTimer: NodeJS.Timeout | undefined;
  private eventRetryAttempt = 0;
  /** True while registered handlers have no live subscription, i.e. events may be missed. */
  private eventsInterrupted = false;
  private readonly eventsRecoveredListeners = new Set<() => void>();
  private readonly connectedListeners = new Set<() => void>();
  private readonly disconnectedListeners = new Set<() => void>();
  private readonly gapListeners = new Set<(gap: GapInfo) => void>();
  private readonly subscriptionErrorListeners = new Set<(info: SubscriptionErrorInfo) => void>();

  constructor(private readonly options: MisaoConnectionOptions) {}

  /** Makes the first connect attempt; later attempts continue in the background. Never rejects on an unreachable daemon. */
  async start(): Promise<void> {
    if (this.client) throw new Error('MisaoConnection already started');
    const { sdk } = this.options;
    const client = new sdk.MisaoClient({ socketPath: this.options.socketPath });
    this.client = client;
    client.onStateChange((state) => this.handleState(state));
    client.onGap((gap) => { for (const listener of this.gapListeners) listener(gap); });
    client.onSubscriptionError((info) => this.handleSubscriptionError(info));
    client.onError((err) => this.options.log.warn(`[misao] callback error: ${err instanceof Error ? err.message : String(err)}`));
    await this.connectAttempt(client, 1);
  }

  availability(): MuxDriverAvailability {
    return this.status === 'connected' ? { available: true } : { available: false, reason: 'daemon_unreachable' };
  }

  async request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    try {
      return await this.requireClient().request(method, params);
    } catch (err) {
      throw this.translate(err);
    }
  }

  /**
   * The SDK holds one events subscription per connection, so the connection owns it and fans it out to every handler:
   * the first handler subscribes, the last unsubscribe releases it. While the daemon is connected, the subscription is
   * maintained here (re-made with backoff after a refused re-subscribe or a failed first attempt); the call rejects only
   * when the daemon is not reachable, in which case the handler is not registered and the caller retries on connect.
   */
  async subscribeEvents(handler: EventHandler): Promise<EventRegistration> {
    const registered = { handler };
    this.eventHandlers.add(registered);
    const registration: EventRegistration = {
      unsubscribe: () => {
        this.eventHandlers.delete(registered);
        this.releaseEventSubscriptionIfUnused();
      },
    };
    try {
      await this.ensureEventSubscription();
    } catch (err) {
      if (this.status !== 'connected' || this.isConnectionError(err)) {
        registration.unsubscribe();
        throw this.translate(err);
      }
      this.eventsInterrupted = true;
      this.options.log.warn(`[misao] events subscription failed, retrying in the background: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleEventRetry();
    }
    return registration;
  }

  private ensureEventSubscription(): Promise<void> {
    if (this.eventSubscription) return Promise.resolve();
    this.eventSubscribing ??= this.requireClient().subscribeEvents((event) => this.dispatchEvent(event))
      .then((subscription) => {
        // The last registration left (or the connection closed) while this was in flight: nobody wants it any more.
        if (this.eventHandlers.size === 0 || this.status === 'closed') {
          subscription.unsubscribe();
          return;
        }
        this.eventSubscription = subscription;
        this.clearEventRetry();
        if (!this.eventsInterrupted) return;
        this.eventsInterrupted = false;
        for (const listener of this.eventsRecoveredListeners) listener();
      })
      .finally(() => { this.eventSubscribing = undefined; });
    return this.eventSubscribing;
  }

  private scheduleEventRetry(): void {
    if (this.eventRetryTimer || this.eventHandlers.size === 0 || this.status === 'closed') return;
    this.eventRetryAttempt += 1;
    const { sdk } = this.options;
    this.eventRetryTimer = setTimeout(() => {
      this.eventRetryTimer = undefined;
      this.retryEventSubscription();
    }, sdk.computeBackoffDelay(this.eventRetryAttempt, sdk.DEFAULT_BACKOFF));
    this.eventRetryTimer.unref();
  }

  /** Re-makes the shared subscription for the handlers that are still registered. A lost connection is picked up by the next connected transition. */
  private retryEventSubscription(): void {
    if (this.eventHandlers.size === 0 || this.status !== 'connected') return;
    this.ensureEventSubscription().catch((err: unknown) => {
      if (this.isConnectionError(err)) return;
      this.options.log.warn(`[misao] events subscription retry failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleEventRetry();
    });
  }

  /** The SDK already dropped its own registration when it reports a refused re-subscribe; ours is stale. */
  private handleSubscriptionError(info: SubscriptionErrorInfo): void {
    if (info.stream.kind === 'events') {
      this.eventSubscription = undefined;
      this.eventsInterrupted = true;
      this.options.log.warn(`[misao] events re-subscribe refused, retrying in the background: ${info.error.message}`);
      this.scheduleEventRetry();
    }
    for (const listener of this.subscriptionErrorListeners) listener(info);
  }

  private releaseEventSubscriptionIfUnused(): void {
    if (this.eventHandlers.size > 0) return;
    this.clearEventRetry();
    this.eventsInterrupted = false;
    this.eventSubscription?.unsubscribe();
    this.eventSubscription = undefined;
  }

  private clearEventRetry(): void {
    if (this.eventRetryTimer) clearTimeout(this.eventRetryTimer);
    this.eventRetryTimer = undefined;
    this.eventRetryAttempt = 0;
  }

  private dispatchEvent(event: Parameters<EventHandler>[0]): void {
    for (const { handler } of [...this.eventHandlers]) {
      try {
        handler(event);
      } catch (err) {
        this.options.log.warn(`[misao] event handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async subscribeLines(paneId: string, handler: LineHandler): Promise<Subscription> {
    try {
      return await this.requireClient().subscribeLines(paneId, handler);
    } catch (err) {
      throw this.translate(err);
    }
  }

  onSubscriptionError(listener: (info: SubscriptionErrorInfo) => void): () => void {
    this.subscriptionErrorListeners.add(listener);
    return () => { this.subscriptionErrorListeners.delete(listener); };
  }

  onGap(listener: (gap: GapInfo) => void): () => void {
    this.gapListeners.add(listener);
    return () => { this.gapListeners.delete(listener); };
  }

  onEventsRecovered(listener: () => void): () => void {
    this.eventsRecoveredListeners.add(listener);
    return () => { this.eventsRecoveredListeners.delete(listener); };
  }

  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => { this.connectedListeners.delete(listener); };
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => { this.disconnectedListeners.delete(listener); };
  }

  rpcErrorCode(err: unknown): number | undefined {
    return err instanceof this.options.sdk.MisaoRpcError ? err.code : undefined;
  }

  isConnectionError(err: unknown): boolean {
    return err instanceof this.options.sdk.MisaoConnectionError;
  }

  close(): void {
    this.status = 'closed';
    this.clearEventRetry();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.client?.close();
  }

  private requireClient(): MisaoClient {
    if (!this.client) throw new MuxDriverUnavailableError('misao', 'daemon_unreachable');
    return this.client;
  }

  private translate(err: unknown): unknown {
    return this.isConnectionError(err) ? new MuxDriverUnavailableError('misao', 'daemon_unreachable') : err;
  }

  private handleState(state: ConnectionState): void {
    if (this.status === 'closed') return;
    if (state.status === 'connected') {
      this.status = 'connected';
      this.retryEventSubscription();
      for (const listener of this.connectedListeners) listener();
    } else {
      if (state.status === 'closed' && state.cause) {
        this.options.log.warn(`[misao] connection closed permanently: ${state.cause.message}`);
      }
      const wasConnected = this.status === 'connected';
      this.status = state.status === 'closed' ? 'closed' : 'disconnected';
      if (wasConnected) for (const listener of this.disconnectedListeners) listener();
    }
  }

  private async connectAttempt(client: MisaoClient, attempt: number): Promise<void> {
    if (this.status === 'closed') return;
    const { sdk } = this.options;
    try {
      await client.connect();
    } catch (err) {
      if (!(err instanceof sdk.MisaoConnectionError)) {
        this.options.log.warn(`[misao] giving up connecting: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (attempt === 1) this.options.log.warn(`[misao] daemon not reachable, retrying in the background: ${err.message}`);
      const delayMs = sdk.computeBackoffDelay(attempt, sdk.DEFAULT_BACKOFF);
      this.retryTimer = setTimeout(() => { void this.connectAttempt(client, attempt + 1); }, delayMs);
      this.retryTimer.unref();
    }
  }
}

/** Opens a connection that is not shared with the driver, so closing it detaches only that terminal. */
export async function connectDedicatedMisaoClient(sdk: MisaoSdk, socketPath: string): Promise<MisaoAttachClient> {
  const client = new sdk.MisaoClient({ socketPath });
  try {
    await client.connect();
  } catch (err) {
    client.close();
    if (err instanceof sdk.MisaoConnectionError) throw new MuxDriverUnavailableError('misao', 'daemon_unreachable');
    throw err;
  }
  return client;
}
