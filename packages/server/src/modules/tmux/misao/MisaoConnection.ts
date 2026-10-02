import type { MisaoClient, EventHandler, GapInfo, Subscription, ConnectionState } from '@misao/sdk' with { 'resolution-mode': 'import' };
import type { MethodName, MethodParams, MethodResult } from '@misao/protocol' with { 'resolution-mode': 'import' };
import type { MuxDriverAvailability } from '../MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../MuxCapabilityError';

// @misao/sdk is ESM-only while the server compiles to CJS: types come via resolution-mode, values via dynamic import().
export type MisaoSdk = typeof import('@misao/sdk', { with: { 'resolution-mode': 'import' } });

export interface MisaoRpc {
  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** The daemon's error code when `err` is an RPC error response, otherwise undefined. */
  rpcErrorCode(err: unknown): number | undefined;
}

export interface MisaoEventSource {
  subscribeEvents(handler: EventHandler): Promise<Subscription>;
  onGap(listener: (gap: GapInfo) => void): () => void;
  /** Fires on every transition into the connected state (first connect, retry success, SDK reconnect). */
  onConnected(listener: () => void): () => void;
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
export class MisaoConnection implements MisaoRpc, MisaoEventSource {
  private client: MisaoClient | undefined;
  private status: Status = 'idle';
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly connectedListeners = new Set<() => void>();
  private readonly gapListeners = new Set<(gap: GapInfo) => void>();

  constructor(private readonly options: MisaoConnectionOptions) {}

  /** Makes the first connect attempt; later attempts continue in the background. Never rejects on an unreachable daemon. */
  async start(): Promise<void> {
    if (this.client) throw new Error('MisaoConnection already started');
    const { sdk } = this.options;
    const client = new sdk.MisaoClient({ socketPath: this.options.socketPath });
    this.client = client;
    client.onStateChange((state) => this.handleState(state));
    client.onGap((gap) => { for (const listener of this.gapListeners) listener(gap); });
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
    return err instanceof this.options.sdk.MisaoConnectionError ? new MuxDriverUnavailableError('misao', 'daemon_unreachable') : err;
  }

  private handleState(state: ConnectionState): void {
    if (this.status === 'closed') return;
    if (state.status === 'connected') {
      this.status = 'connected';
      for (const listener of this.connectedListeners) listener();
    } else {
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
