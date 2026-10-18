import type { PaneHandle } from '@azito/shared';
import type { GapInfo, Subscription, SubscriptionErrorInfo } from '@misao/sdk' with { 'resolution-mode': 'import' };
import { BasePaneStream } from '../PaneOutputStream';
import type { PaneStreamGapEvent } from '../PaneStream';
import type { MisaoLineSource } from './MisaoConnection';

/**
 * Reads a pane's output from the daemon's line stream instead of a pipe-pane file. Reconnects are not this class's job:
 * within one client the SDK resumes from the last seq, and when the connection replaces its client MisaoConnection
 * re-subscribes from the last cursor. Lines lost anyway (daemon restart, ring overrun) are reported as 'gap'; phase
 * completion is decided by the signal stream, so a gap only costs buffered output. A refused re-subscribe or a
 * failed subscribe is reported as 'subscription_error' ('error' would crash the process when nobody listens).
 *
 * Known limitation: stop() unsubscribes on the client side only (the SDK drops the stream locally). The protocol has
 * no way to end a line subscription yet, so the daemon keeps sending this pane's lines over the shared connection
 * until the pane closes or the connection is re-established; ending it on the daemon side waits for misao to add
 * pane.unsubscribe_lines.
 */
export class MisaoPaneStream extends BasePaneStream {
  protected filePath = '';
  private subscription: Subscription | undefined;
  private offGap: (() => void) | undefined;
  private offSubscriptionError: (() => void) | undefined;

  constructor(
    private readonly pane: PaneHandle,
    private readonly source: MisaoLineSource,
  ) {
    super();
  }

  start(): void {
    this.offGap = this.source.onGap((gap) => this.handleGap(gap));
    this.offSubscriptionError = this.source.onSubscriptionError((info) => this.handleSubscriptionError(info));
    this.source.subscribeLines(this.pane, (line) => {
      if (this.closed) return;
      this.processChunk(line.text + '\n');
    }).then(
      (subscription) => {
        if (this.closed) subscription.unsubscribe();
        else this.subscription = subscription;
      },
      (err: unknown) => {
        if (!this.closed) this.emit('subscription_error', err);
      },
    );
  }

  stop(): void {
    this.closed = true;
    this.offGap?.();
    this.offSubscriptionError?.();
    this.offGap = undefined;
    this.offSubscriptionError = undefined;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private handleGap(gap: GapInfo): void {
    if (this.closed || gap.stream.kind !== 'lines' || gap.stream.paneId !== this.pane) return;
    const event: PaneStreamGapEvent = { reason: gap.reason };
    this.emit('gap', event);
  }

  private handleSubscriptionError(info: SubscriptionErrorInfo): void {
    if (this.closed || info.stream.kind !== 'lines' || info.stream.paneId !== this.pane) return;
    this.emit('subscription_error', info.error);
  }
}
