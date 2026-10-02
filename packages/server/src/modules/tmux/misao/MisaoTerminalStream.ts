import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { ITerminalStream } from '../../servers/transport/ServerTransport';
import type { MisaoAttachClient } from './MisaoConnection';

const PANE_EXITED = 1002;

export interface MisaoTerminalStreamOptions {
  client: MisaoAttachClient;
  paneId: string;
  clientId: string;
  cols: number;
  rows: number;
  log: { warn(message: string): void };
  /** The daemon's error code when `err` is an RPC error response, otherwise undefined. */
  rpcErrorCode(err: unknown): number | undefined;
}

/**
 * One browser terminal attached to one pane over a dedicated daemon connection. Emits 'data' (string) and
 * 'close'; closing the connection makes the daemon detach the client. The SDK does not restore an attach after a
 * reconnect, so a lost connection closes the stream and the browser reconnects with a fresh snapshot.
 */
export class MisaoTerminalStream extends EventEmitter implements ITerminalStream {
  private readonly decoder = new StringDecoder('utf8');
  private finished = false;
  /** Output that arrived before anyone listened (the snapshot can land before open() resolves to its caller). */
  private pending: string[] = [];

  private constructor(private readonly options: MisaoTerminalStreamOptions) {
    super();
    this.on('newListener', (event) => {
      if (event === 'data') process.nextTick(() => this.flushPending());
    });
  }

  /** Handlers are registered before attaching so the replayed snapshot is not missed. Rejects when the attach fails; the caller closes the client. */
  static async open(options: MisaoTerminalStreamOptions): Promise<MisaoTerminalStream> {
    const stream = new MisaoTerminalStream(options);
    const { client, paneId, clientId, cols, rows } = options;
    client.onNotification((n) => {
      if (n.method !== 'pane.output' || n.params.paneId !== paneId) return;
      const text = stream.decoder.write(Buffer.from(n.params.dataB64, 'base64'));
      if (!text) return;
      if (stream.listenerCount('data') === 0) stream.pending.push(text);
      else stream.emit('data', text);
    });
    client.onStateChange((state) => {
      if (state.status !== 'connected') stream.finish(true);
    });
    await client.subscribeEvents((event) => {
      if (event.type === 'pane.closed' && event.paneId === paneId) stream.finish(true);
    });
    await client.request('pane.attach', { paneId, clientId, mode: 'raw', replay: 'snapshot', cols, rows });
    return stream;
  }

  write(data: string): void {
    if (this.finished) return;
    const { paneId, clientId } = this.options;
    void this.send(() => this.options.client.request('pane.write', { paneId, data, clientId, source: 'terminal' }));
  }

  resize(cols: number, rows: number): void {
    if (this.finished) return;
    const { paneId, clientId } = this.options;
    void this.send(() => this.options.client.request('pane.resize', { paneId, cols, rows, clientId }));
  }

  close(): void {
    this.finish(false);
  }

  private async send(op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (err) {
      // Requests still in flight when the stream finished reject with the closed connection; nothing to report.
      if (this.finished) return;
      // A finished pane has nobody to tell about keystrokes; it stays visible as its final screen.
      if (this.options.rpcErrorCode(err) === PANE_EXITED) return;
      this.options.log.warn(`[misao] terminal ${this.options.clientId} request failed: ${err instanceof Error ? err.message : String(err)}`);
      this.finish(true);
    }
  }

  private flushPending(): void {
    const chunks = this.pending;
    this.pending = [];
    for (const chunk of chunks) this.emit('data', chunk);
  }

  private finish(emitClose: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.options.client.close();
    if (emitClose) this.emit('close');
  }
}
