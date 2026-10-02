import type { PaneHandle } from '@azito/shared';
import type { GapInfo, Subscription, SubscriptionErrorInfo } from '@misao/sdk' with { 'resolution-mode': 'import' };
import { BasePaneStream } from '../PaneOutputStream';
import type { MisaoLineSource, MisaoRpc } from './MisaoConnection';

/**
 * Reads a pane's output from the daemon's line stream instead of a pipe-pane file. Reconnects are the SDK's job:
 * it resumes from the last seq. When lines were lost anyway (daemon restart, ring overrun) the visible screen is
 * scanned for markers and 'gap' is emitted. A refused re-subscribe or a failed subscribe is reported as
 * 'subscription_error' ('error' would crash the process when nobody listens).
 */
export class MisaoPaneStream extends BasePaneStream {
  protected filePath = '';
  private subscription: Subscription | undefined;
  private offGap: (() => void) | undefined;
  private offSubscriptionError: (() => void) | undefined;

  constructor(
    private readonly pane: PaneHandle,
    private readonly source: MisaoLineSource & MisaoRpc,
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
    this.emit('gap', { reason: gap.reason });
    this.source.request('pane.screen', { paneId: this.pane }).then(
      ({ text }) => { if (!this.closed) this.scanForMarkers(text); },
      (err: unknown) => { if (!this.closed) this.emit('subscription_error', err); },
    );
  }

  private handleSubscriptionError(info: SubscriptionErrorInfo): void {
    if (this.closed || info.stream.kind !== 'lines' || info.stream.paneId !== this.pane) return;
    this.emit('subscription_error', info.error);
  }
}
