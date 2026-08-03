import { EventEmitter } from 'events';
import type { IPaneStream } from '../../tmux/PaneStream';
import type { TurnSignalHub, TurnSignal } from './TurnSignalHub';

/**
 * `IPaneStream` adapter over `TurnSignalHub`: lets `WorkerWaiter` (which only
 * knows how to listen for `'marker'`/`'data'` events on an `IPaneStream`)
 * consume signals posted by `azitoctl` via `POST /api/agent-signals` instead
 * of tailing a tmux pipe-pane file.
 *
 * Event mapping — cross-checked against the actual receiver in
 * WorkerWaiter.waitForWorker (packages/server/src/modules/tasks/execution/WorkerWaiter.ts):
 *   - `markerSource.on('marker', (type, raw) => ...)`: `type === 'phase_complete'` finishes
 *     the wait with `{status:'phase_complete'}` (the `raw` argument is only read for the
 *     `questions_json` branch, where it's `JSON.parse`d). So `complete` always emits
 *     `'marker', 'phase_complete'` regardless of `testFailed` — the caller distinguishes
 *     test-failed turns afterwards via `AgentTurn.status`, not via the marker event.
 *   - `type === 'questions_json'`: `raw` must be a JSON string of the questions array
 *     (`JSON.parse(raw)` is called directly on it), so `questions` is re-serialized here.
 *   - `fail`: WorkerWaiter has no dedicated marker branch for a hard failure signal, so
 *     this also emits `'marker', 'phase_complete'` — purely to unblock a wait that would
 *     otherwise sit until idle/phase-duration timeout. The marker's own classification is
 *     NOT the source of truth here: the caller (HttpSignalTurnCoordinator.finalize)
 *     re-reads `AgentTurn.status` after the wait settles and treats `'failed'` as
 *     authoritative, overriding whatever this marker implied.
 *   - `progress`: WorkerWaiter registers `signalStream.on('data', ...)` (only for the
 *     `signalStream`, not unconditionally) and uses it solely to refresh `lastDataTime`
 *     for idle-timeout purposes — it does not append the payload to any buffer. Emitting
 *     `'data'` with an empty string is therefore sufficient and correct.
 *
 * Listener-registration race: `TurnSignalHub.emitSignal` is a synchronous, unbuffered
 * `EventEmitter.emit` — a signal posted before `waitForWorker` has attached its `'marker'`
 * listener (e.g. while `sendKeys` is still in flight) would otherwise be lost. To close
 * that window, decisive signals (`complete`/`questions`/`fail` — never `progress`, whose
 * loss is harmless) are buffered whenever no `'marker'` listener is attached yet, and
 * flushed via the `newListener` event once one is.
 */
export class InProcessSignalStream extends EventEmitter implements IPaneStream {
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private pendingSignals: TurnSignal[] = [];

  constructor(
    private hub: TurnSignalHub,
    private turnId: number,
  ) {
    super();
    // 'newListener' fires just BEFORE the listener is actually attached, so
    // flushing synchronously here would still see zero 'marker' listeners
    // and be a silent no-op. Defer to the next tick, after attachment.
    this.on('newListener', (event: string) => {
      if (event === 'marker' && this.pendingSignals.length > 0) {
        process.nextTick(() => this.flushPending());
      }
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.hub.subscribe(this.turnId, (signal) => this.handleSignal(signal));
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.started = false;
  }

  private handleSignal(signal: TurnSignal): void {
    const isDecisive = signal.type === 'complete' || signal.type === 'questions' || signal.type === 'fail';
    if (isDecisive && this.listenerCount('marker') === 0) {
      this.pendingSignals.push(signal);
      return;
    }
    this.emitMarkerFor(signal);
  }

  private flushPending(): void {
    const pending = this.pendingSignals;
    this.pendingSignals = [];
    for (const signal of pending) this.emitMarkerFor(signal);
  }

  private emitMarkerFor(signal: TurnSignal): void {
    switch (signal.type) {
      case 'complete':
        this.emit('marker', 'phase_complete');
        break;
      case 'questions':
        this.emit('marker', 'questions_json', JSON.stringify(signal.questions));
        break;
      case 'fail':
        // See class doc: unblocks the wait only, not authoritative on its own.
        this.emit('marker', 'phase_complete');
        break;
      case 'progress':
        this.emit('data', '');
        break;
    }
  }

  // ─── IPaneStream: not meaningful for an in-process signal source ───

  setMarkers(_done: string, _questions: string): void {
    // No-op: markers are structural to tmux pipe-pane text parsing; this stream
    // already receives typed signals, so there is nothing to configure.
  }

  enableMarkerDetection(): void {
    // No-op: marker detection is always "on" — every received signal is typed.
  }

  getBuffer(): string {
    return '';
  }

  getFilePath(): string {
    return '(in-process)';
  }
}
