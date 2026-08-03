import { EventEmitter } from 'events';

export type TurnSignal =
  | { type: 'complete'; testFailed: boolean; summary?: string; output?: string }
  | { type: 'questions'; questions: unknown[] }
  | { type: 'fail'; reason?: string }
  | { type: 'progress' };

/**
 * In-process pub/sub between `AgentSignalService` (HTTP receiver) and
 * `InProcessSignalStream` (the `IPaneStream` a WorkerWaiter subscribes to
 * for a given turn). One turn <-> at most one active subscriber at a time.
 */
export class TurnSignalHub {
  private emitter = new EventEmitter();

  private static channelFor(turnId: number): string {
    return `turn:${turnId}`;
  }

  emitSignal(turnId: number, signal: TurnSignal): void {
    this.emitter.emit(TurnSignalHub.channelFor(turnId), signal);
  }

  /** Returns an unsubscribe function. */
  subscribe(turnId: number, cb: (signal: TurnSignal) => void): () => void {
    const channel = TurnSignalHub.channelFor(turnId);
    this.emitter.on(channel, cb);
    return () => this.emitter.off(channel, cb);
  }
}
