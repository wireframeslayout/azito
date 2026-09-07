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
      if (!this.closed) this.emit('error', err);
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

    const prevLines = prev.split('\n');
    const nextLines = next.split('\n');

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
