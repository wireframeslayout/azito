import { describe, it, expect } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import { MisaoPaneStream } from './MisaoPaneStream';
import type { MisaoLineSource } from './MisaoConnection';

const PANE = asPaneHandle('p_1');
const DONE = 'AZITO_DONE_7_abc';

class FakeSource {
  lineHandler: ((line: { text: string }) => void) | undefined;
  gapListeners = new Set<(gap: unknown) => void>();
  errorListeners = new Set<(info: unknown) => void>();
  unsubscribed = 0;
  subscribeError: Error | undefined;
  private release: (() => void) | undefined;
  /** Holds the subscribe reply until release() is called. */
  hold = false;

  subscribeLines(_paneId: string, handler: (line: { text: string }) => void): Promise<{ unsubscribe(): void }> {
    if (this.subscribeError) return Promise.reject(this.subscribeError);
    this.lineHandler = handler;
    const reply = { unsubscribe: () => { this.unsubscribed += 1; } };
    if (!this.hold) return Promise.resolve(reply);
    return new Promise((resolve) => { this.release = () => resolve(reply); });
  }
  releaseSubscribe(): void { this.release?.(); }
  onGap(l: (gap: unknown) => void): () => void { this.gapListeners.add(l); return () => { this.gapListeners.delete(l); }; }
  onSubscriptionError(l: (info: unknown) => void): () => void { this.errorListeners.add(l); return () => { this.errorListeners.delete(l); }; }
  emitGap(paneId: string, reason: 'epoch' | 'truncated'): void {
    for (const l of this.gapListeners) l({ stream: { kind: 'lines', paneId }, reason });
  }
}

function setup(): { source: FakeSource; stream: MisaoPaneStream; markers: unknown[][]; gaps: unknown[]; errors: unknown[] } {
  const source = new FakeSource();
  const stream = new MisaoPaneStream(PANE, source as unknown as MisaoLineSource);
  const markers: unknown[][] = [];
  const gaps: unknown[] = [];
  const errors: unknown[] = [];
  stream.on('marker', (...args) => markers.push(args));
  stream.on('gap', (g) => gaps.push(g));
  stream.on('subscription_error', (e) => errors.push(e));
  stream.setMarkers(DONE, 'AZITO_QUESTIONS_7_abc');
  stream.enableMarkerDetection();
  return { source, stream, markers, gaps, errors };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('MisaoPaneStream', () => {
  it('has no output file', () => {
    expect(setup().stream.getFilePath()).toBe('');
  });

  it('detects the done marker in streamed lines and buffers the text', async () => {
    const { source, stream, markers } = setup();
    stream.start();
    await flush();
    source.lineHandler!({ text: 'working' });
    source.lineHandler!({ text: DONE });
    expect(markers).toEqual([['phase_complete', `working\n${DONE}\n`]]);
    expect(stream.getBuffer()).toBe(`working\n${DONE}\n`);
  });

  it('ignores lines after stop and unsubscribes', async () => {
    const { source, stream, markers } = setup();
    stream.start();
    await flush();
    stream.stop();
    source.lineHandler!({ text: DONE });
    expect(markers).toEqual([]);
    expect(source.unsubscribed).toBe(1);
    expect(source.gapListeners.size).toBe(0);
    expect(source.errorListeners.size).toBe(0);
  });

  it('unsubscribes right after the reply when stopped before the subscribe completed', async () => {
    const { source, stream } = setup();
    source.hold = true;
    stream.start();
    stream.stop();
    expect(source.unsubscribed).toBe(0);
    source.releaseSubscribe();
    await flush();
    expect(source.unsubscribed).toBe(1);
  });

  it('reports a gap of its own pane without touching the buffer', async () => {
    const { source, stream, gaps } = setup();
    stream.start();
    await flush();
    source.lineHandler!({ text: 'before' });
    source.emitGap('p_1', 'epoch');
    expect(gaps).toEqual([{ reason: 'epoch' }]);
    expect(stream.getBuffer()).toBe('before\n');
  });

  it('ignores gaps of other panes and other streams', async () => {
    const { source, stream, gaps } = setup();
    stream.start();
    await flush();
    source.emitGap('p_2', 'epoch');
    for (const l of source.gapListeners) l({ stream: { kind: 'events' }, reason: 'epoch' });
    await flush();
    expect(gaps).toEqual([]);
  });

  it('reports a failed subscribe and a refused re-subscribe of its own pane only', async () => {
    const failing = setup();
    failing.source.subscribeError = new Error('stream already registered');
    failing.stream.start();
    await flush();
    expect(failing.errors).toEqual([failing.source.subscribeError]);

    const { source, stream, errors } = setup();
    stream.start();
    await flush();
    const refused = new Error('pane not found');
    for (const l of source.errorListeners) l({ stream: { kind: 'lines', paneId: 'p_2' }, error: new Error('other') });
    for (const l of source.errorListeners) l({ stream: { kind: 'lines', paneId: 'p_1' }, error: refused });
    expect(errors).toEqual([refused]);
    stream.stop();
    for (const l of source.errorListeners) l({ stream: { kind: 'lines', paneId: 'p_1' }, error: refused });
    expect(errors).toHaveLength(1);
  });
});
