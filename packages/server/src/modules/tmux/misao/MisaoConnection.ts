import type { MisaoClient, EventHandler, LineHandler, GapInfo, Subscription, SubscriptionErrorInfo, ConnectionState, ConnectFunction } from '@misao/sdk' with { 'resolution-mode': 'import' };
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

/**
 * Per-pane line stream. A reconnect of the same SDK client is restored by the SDK itself; when the connection replaces
 * its client (the SDK gave up on it), the connection re-subscribes every line stream on the new client from its last
 * cursor (a daemon restart or truncated history is reported through onGap). A re-subscribe the daemon refuses is
 * reported through onSubscriptionError, and that stream is dropped.
 */
export interface MisaoLineSource {
  subscribeLines(paneId: string, handler: LineHandler): Promise<Subscription>;
  onGap(listener: (gap: GapInfo) => void): () => void;
  onSubscriptionError(listener: (info: SubscriptionErrorInfo) => void): () => void;
}

interface LineRegistration {
  paneId: string;
  handler: LineHandler;
  /** The live subscription on the current client; undefined while detached between two clients. */
  subscription: Subscription | undefined;
  /** Where the stream stood when its client was thrown away. */
  lastCursor?: { seq: number; epoch: string };
}

type MisaoProtocolVersionErrorLike = InstanceType<MisaoSdk['MisaoProtocolVersionError']>;

/** How the SDK reaches a daemon: a unix socket path, or a function that opens a Duplex to it (a relay through an agent). */
export type MisaoTarget = { socketPath: string; connect?: never } | { connect: ConnectFunction; socketPath?: never };

export type MisaoConnectionOptions = MisaoTarget & {
  sdk: MisaoSdk;
  log: { warn(message: string): void };
};

type Status = 'idle' | 'connected' | 'disconnected';

/**
 * Retry pacing while the daemon speaks an incompatible protocol: waiting does not fix it by itself, but the operator
 * can reinstall the right daemon at any time, so keep trying at a gentle, capped interval instead of giving up.
 */
const INCOMPATIBLE_BACKOFF = { initialDelayMs: 1_000, maxDelayMs: 30_000, factor: 2 } as const;

/**
 * The hub's single connection to the misao daemon. The SDK retries only after a first successful connect,
 * so the first connect is retried here with the SDK's own backoff until it succeeds or the connection is closed.
 * An incompatible daemon protocol makes the SDK give up for good (and close its client); this class does not: it
 * reports the cause through availability() and keeps retrying, with a fresh client where the SDK's is closed.
 */
export class MisaoConnection implements MisaoRpc, MisaoEventSource, MisaoDisconnectSource, MisaoLineSource {
  private client: MisaoClient | undefined;
  private status: Status = 'idle';
  /** True once close() was called: the only thing that ends the retrying. */
  private disposed = false;
  /** Set while the daemon's protocol is incompatible with this hub's SDK; cleared on the next successful connect. */
  private incompatibility: MisaoProtocolVersionErrorLike | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  /** One entry per registration, so registering the same function twice stays two independent registrations. */
  private readonly eventHandlers = new Set<{ handler: EventHandler }>();
  private eventSubscription: Subscription | undefined;
  private eventSubscribing: Promise<void> | undefined;
  private eventRetryTimer: NodeJS.Timeout | undefined;
  private eventRetryAttempt = 0;
  /** True while registered handlers have no live subscription, i.e. events may be missed. */
  private eventsInterrupted = false;
  /** Line subscriptions the connection keeps alive across a client replacement (the SDK only restores within one client). */
  private readonly lineRegistrations = new Set<LineRegistration>();
  /** True from a client replacement until the lines have been re-subscribed on the new client. */
  private linesNeedRestore = false;
  private readonly eventsRecoveredListeners = new Set<() => void>();
  private readonly connectedListeners = new Set<() => void>();
  private readonly disconnectedListeners = new Set<() => void>();
  private readonly gapListeners = new Set<(gap: GapInfo) => void>();
  private readonly subscriptionErrorListeners = new Set<(info: SubscriptionErrorInfo) => void>();

  constructor(private readonly options: MisaoConnectionOptions) {}

  /** Makes the first connect attempt; later attempts continue in the background. Never rejects on an unreachable daemon. */
  async start(): Promise<void> {
    if (this.client) throw new Error('MisaoConnection already started');
    const client = this.createClient();
    await this.connectAttempt(client, 1);
  }

  availability(): MuxDriverAvailability {
    if (this.status === 'connected') return { available: true };
    return { available: false, reason: this.incompatibility ? 'protocol_incompatible' : 'daemon_unreachable' };
  }

  private createClient(): MisaoClient {
    const client = new this.options.sdk.MisaoClient(clientTarget(this.options));
    this.client = client;
    client.onStateChange((state) => this.handleState(state));
    client.onGap((gap) => { for (const listener of this.gapListeners) listener(gap); });
    client.onSubscriptionError((info) => this.handleSubscriptionError(info));
    client.onError((err) => this.options.log.warn(`[misao] callback error: ${err instanceof Error ? err.message : String(err)}`));
    return client;
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
        if (this.eventHandlers.size === 0 || this.disposed) {
          subscription.unsubscribe();
          return;
        }
        this.eventSubscription = subscription;
        this.clearEventRetry();
        if (!this.eventsInterrupted) return;
        this.eventsInterrupted = false;
        for (const listener of [...this.eventsRecoveredListeners]) {
          try {
            listener();
          } catch (err) {
            this.options.log.warn(`[misao] events recovered listener failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })
      .finally(() => { this.eventSubscribing = undefined; });
    return this.eventSubscribing;
  }

  private scheduleEventRetry(): void {
    if (this.eventRetryTimer || this.eventHandlers.size === 0 || this.disposed) return;
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
    } else {
      // The SDK dropped this line stream from its own table; ours must go too, or a later client replacement would
      // re-subscribe a stream that already ended (and could collide with a fresh subscription of the same pane).
      this.dropLineRegistrations(info.stream.paneId);
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
    let inner: Subscription;
    try {
      inner = await this.requireClient().subscribeLines(paneId, handler);
    } catch (err) {
      throw this.translate(err);
    }
    const registration: LineRegistration = { paneId, handler, subscription: inner };
    this.lineRegistrations.add(registration);
    return {
      get cursor() { return registration.subscription?.cursor ?? registration.lastCursor!; },
      unsubscribe: () => {
        this.lineRegistrations.delete(registration);
        registration.subscription?.unsubscribe();
        registration.subscription = undefined;
      },
    };
  }

  private dropLineRegistrations(paneId: string): void {
    for (const registration of [...this.lineRegistrations]) {
      if (registration.paneId !== paneId) continue;
      this.lineRegistrations.delete(registration);
      try {
        registration.subscription?.unsubscribe();
      } catch (err) {
        this.options.log.warn(`[misao] could not release line subscription for ${paneId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      registration.subscription = undefined;
    }
  }

  /** Detaches the line subscriptions from a client that is being thrown away, keeping their cursors for the new one. */
  private detachLines(): void {
    for (const registration of this.lineRegistrations) {
      try {
        registration.lastCursor = registration.subscription?.cursor ?? registration.lastCursor;
        registration.subscription?.unsubscribe();
      } catch (err) {
        this.options.log.warn(`[misao] could not release line subscription for ${registration.paneId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      registration.subscription = undefined;
    }
    this.linesNeedRestore = this.lineRegistrations.size > 0;
  }

  /** Re-subscribes every detached line stream on the current client, from its last cursor. */
  private restoreLines(): void {
    if (!this.linesNeedRestore) return;
    this.linesNeedRestore = false;
    const client = this.client;
    if (!client) return;
    for (const registration of [...this.lineRegistrations]) {
      if (registration.subscription) continue;
      const since = registration.lastCursor;
      client.subscribeLines(registration.paneId, registration.handler, since ? { since: since.seq, epoch: since.epoch } : undefined).then(
        (subscription) => {
          if (this.lineRegistrations.has(registration)) registration.subscription = subscription;
          else subscription.unsubscribe();
        },
        (err: unknown) => this.handleLineRestoreFailure(registration, err),
      );
    }
  }

  private handleLineRestoreFailure(registration: LineRegistration, err: unknown): void {
    if (!this.lineRegistrations.has(registration)) return;
    // The connection dropped again before the restore finished: the next replacement or connect retries it.
    if (this.isConnectionError(err)) {
      this.linesNeedRestore = true;
      return;
    }
    this.lineRegistrations.delete(registration);
    this.options.log.warn(`[misao] line subscription for ${registration.paneId} could not be restored: ${err instanceof Error ? err.message : String(err)}`);
    const info = { stream: { kind: 'lines', paneId: registration.paneId }, error: err } as SubscriptionErrorInfo;
    for (const listener of this.subscriptionErrorListeners) listener(info);
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
    this.disposed = true;
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
    if (this.disposed) return;
    if (state.status === 'connected') {
      this.status = 'connected';
      this.incompatibility = undefined;
      this.restoreLines();
      this.retryEventSubscription();
      for (const listener of this.connectedListeners) listener();
    } else {
      const wasConnected = this.status === 'connected';
      this.status = 'disconnected';
      if (wasConnected) for (const listener of this.disconnectedListeners) listener();
      if (state.status === 'closed') this.handleClientClosed(state.cause);
    }
  }

  /**
   * The SDK gave up on its client (the daemon came back with an incompatible protocol): it will never reconnect, so
   * start over with a new client. Everything that lived on the old one (events subscription) is re-made on connect.
   */
  private handleClientClosed(cause: unknown): void {
    if (this.isProtocolVersionError(cause)) this.reportIncompatibility(cause);
    else this.options.log.warn(`[misao] connection closed, starting over: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.eventSubscription = undefined;
    this.eventSubscribing = undefined;
    this.eventsInterrupted = this.eventHandlers.size > 0;
    this.detachLines();
    const client = this.createClient();
    this.scheduleConnect(client, 1);
  }

  private isProtocolVersionError(err: unknown): err is MisaoProtocolVersionErrorLike {
    return err instanceof this.options.sdk.MisaoProtocolVersionError;
  }

  private reportIncompatibility(err: MisaoProtocolVersionErrorLike): void {
    // Logged when it first appears or its versions change, not on every retry.
    if (this.incompatibility?.message !== err.message) this.options.log.warn(`[misao] ${err.message}; retrying in the background`);
    this.incompatibility = err;
  }

  private scheduleConnect(client: MisaoClient, attempt: number): void {
    if (this.disposed) return;
    const { sdk } = this.options;
    const backoff = this.incompatibility ? INCOMPATIBLE_BACKOFF : sdk.DEFAULT_BACKOFF;
    this.retryTimer = setTimeout(() => { void this.connectAttempt(client, attempt + 1); }, sdk.computeBackoffDelay(attempt, backoff));
    this.retryTimer.unref();
  }

  private async connectAttempt(client: MisaoClient, attempt: number): Promise<void> {
    if (this.disposed || client !== this.client) return;
    try {
      await client.connect();
    } catch (err) {
      if (this.isProtocolVersionError(err)) {
        this.reportIncompatibility(err);
      } else if (err instanceof this.options.sdk.MisaoConnectionError) {
        this.incompatibility = undefined;
        if (attempt === 1) this.options.log.warn(`[misao] daemon not reachable, retrying in the background: ${err.message}`);
      } else {
        this.options.log.warn(`[misao] giving up connecting: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.scheduleConnect(client, attempt);
    }
  }
}

function clientTarget(target: MisaoTarget): { socketPath: string } | { connect: ConnectFunction } {
  return target.connect ? { connect: target.connect } : { socketPath: target.socketPath };
}

/** Opens a connection that is not shared with the driver, so closing it detaches only that terminal. */
export async function connectDedicatedMisaoClient(sdk: MisaoSdk, target: MisaoTarget): Promise<MisaoAttachClient> {
  const client = new sdk.MisaoClient(clientTarget(target));
  try {
    await client.connect();
  } catch (err) {
    client.close();
    if (err instanceof sdk.MisaoConnectionError) throw new MuxDriverUnavailableError('misao', 'daemon_unreachable');
    throw err;
  }
  return client;
}
