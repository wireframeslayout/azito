import type { EventEmitter } from 'events';
import type { ServerConfig } from '../servers/Server';

export interface IPaneStream extends EventEmitter {
  setMarkers(done: string, questions: string): void;
  getFilePath(): string;
  enableMarkerDetection(): void;
  start(): void;
  getBuffer(): string;
  stop(): void;
}

export interface IPaneStreamFactory {
  create(paneId: string, server: Pick<ServerConfig, 'type' | 'host' | 'agentPort' | 'agentToken'>): IPaneStream;
}
