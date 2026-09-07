import { BasePaneStream } from '../../tmux/PaneOutputStream';
import type { IPaneStream } from '../../tmux/PaneStream';

export type { IPaneStream };

export type HerdrRpcFn = (method: string, params: unknown) => Promise<Record<string, unknown>>;

interface PaneReadResult {
  text: string;
  revision: number;
  truncated: boolean;
}

const POLL_INTERVAL_MS = 500;
const MAX_CONSECUTIVE_ERRORS = 5;
const POLL_LINES = 200;

/**
 * IPaneStream implementation for herdr: polls pane.read with revision
 * tracking instead of tmux pipe-pane.  Reuses BasePaneStream's marker
 * detection (processChunk → checkLine).
 */
export class HerdrPaneStream extends BasePaneStream implements IPaneStream {
  protected filePath = '';

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRevision = -1;
  private lastText = '';
  private polling = false;
  private consecutiveErrors = 0;

  constructor(
    private paneId: string,
    private rpc: HerdrRpcFn,
  ) {
    super();
  }

  start(): void {
    this.pollTimer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
    void this.poll();
  }

  stop(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const resp = await this.rpc('pane.read', {
        pane_id: this.paneId,
        source: 'recent',
        lines: POLL_LINES,
        strip_ansi: true,
      });
      if (this.closed) return;

      this.consecutiveErrors = 0;
      const read = (resp.read ?? resp) as PaneReadResult;
      const revision = read.revision ?? -1;
      const text = read.text ?? '';

      if (revision === this.lastRevision) return;
      if (this.lastRevision === -1) {
        this.lastRevision = revision;
        this.lastText = text;
        return;
      }

      this.lastRevision = revision;
      const newContent = this.extractDiff(this.lastText, text);
      this.lastText = text;

      if (newContent) {
        this.processChunk(newContent);
      }
    } catch (err) {
      if (this.closed) return;
      this.consecutiveErrors += 1;
      const message = (err as Error).message ?? String(err);
      const fatal = /pane_not_found/.test(message) || this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
      // An EventEmitter 'error' with no listener is an uncaught exception that kills the hub
      // (observed on rc.15). Surface the failure without ever throwing out of the timer.
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      } else {
        console.warn('[HerdrPaneStream] pane.read failed for %s (%d/%d): %s', this.paneId, this.consecutiveErrors, MAX_CONSECUTIVE_ERRORS, message);
      }
      if (fatal) {
        console.warn('[HerdrPaneStream] giving up on %s: %s', this.paneId, message);
        this.stop();
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Extract new content by finding the overlap between the previous
   * text's tail and the new text's head.  Falls back to emitting the
   * entire new text with a warning when no overlap is found.
   */
  private extractDiff(prev: string, next: string): string {
    if (!prev) return next;
    if (prev === next) return '';

    const prevLines = prev.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '');
    const nextLines = next.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '');

    const maxOverlap = Math.min(prevLines.length, nextLines.length);
    let bestOverlap = 0;

    for (let overlap = maxOverlap; overlap >= 1; overlap--) {
      const prevTail = prevLines.slice(prevLines.length - overlap);
      const nextHead = nextLines.slice(0, overlap);
      let match = true;
      for (let i = 0; i < overlap; i++) {
        if (prevTail[i] !== nextHead[i]) { match = false; break; }
      }
      if (match) {
        bestOverlap = overlap;
        break;
      }
    }

    if (bestOverlap > 0) {
      const newLines = nextLines.slice(bestOverlap);
      return newLines.length > 0 ? newLines.join('\n') + '\n' : '';
    }

    this.emit('error', new Error(
      `HerdrPaneStream(${this.paneId}): no overlap found between consecutive pane.read results; ` +
      `output may have been lost (prev ${prevLines.length} lines, next ${nextLines.length} lines)`,
    ));
    return next.endsWith('\n') ? next : next + '\n';
  }
}
