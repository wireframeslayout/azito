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

export interface MisaoEventSource {
  subscribeEvents(handler: EventHandler): Promise<Subscription>;
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

  onGap(listener: (gap: GapInfo) => void): () => void;
  /** Fires on every transition into the connected state (first connect, retry success, SDK reconnect). */
  onConnected(listener: () => void): () => void;
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
export class MisaoConnection implements MisaoRpc, MisaoEventSource, MisaoLineSource {
  private client: MisaoClient | undefined;
  private status: Status = 'idle';
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly connectedListeners = new Set<() => void>();
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
    client.onSubscriptionError((info) => { for (const listener of this.subscriptionErrorListeners) listener(info); });
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

  async subscribeEvents(handler: EventHandler): Promise<Subscription> {
    try {
      return await this.requireClient().subscribeEvents(handler);
    } catch (err) {
      throw this.translate(err);
    }
  }

  onGap(listener: (gap: GapInfo) => void): () => void {
    this.gapListeners.add(listener);
    return () => { this.gapListeners.delete(listener); };
  }

  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => { this.connectedListeners.delete(listener); };
  }

  rpcErrorCode(err: unknown): number | undefined {
    return err instanceof this.options.sdk.MisaoRpcError ? err.code : undefined;
  }

  isConnectionError(err: unknown): boolean {
    return err instanceof this.options.sdk.MisaoConnectionError;
  }

  close(): void {
    this.status = 'closed';
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
      for (const listener of this.connectedListeners) listener();
    } else {
      if (state.status === 'closed' && state.cause) {
        this.options.log.warn(`[misao] connection closed permanently: ${state.cause.message}`);
      }
      this.status = state.status === 'closed' ? 'closed' : 'disconnected';
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
