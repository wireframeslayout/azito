import type { EventEmitter } from 'events';
import type { PaneHandle } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';

/** Payload of 'gap': lines the stream will never deliver (misao: daemon restart or ring overrun). */
export interface PaneStreamGapEvent {
  reason: string;
}

/**
 * Besides 'data' and 'marker', a stream reading from a live source (MisaoPaneStream) may emit:
 * - 'gap' with a {@link PaneStreamGapEvent}
 * - 'subscription_error' with an `Error`: the stream could not (re)subscribe and delivers nothing more
 * File-backed streams emit neither.
 */
export interface IPaneStream extends EventEmitter {
  setMarkers(done: string, questions: string): void;
  getFilePath(): string;
  enableMarkerDetection(): void;
  start(): void;
  getBuffer(): string;
  stop(): void;
}

export interface IPaneStreamFactory {
  /** `pane` is the real pane the stream reads from; it is absent for streams backed by a file the agent writes to (signal files). */
  create(handle: PaneHandle | string, server: Pick<ServerConfig, 'type' | 'host' | 'agentPort' | 'agentToken'>, pane?: PaneHandle): IPaneStream;
}
