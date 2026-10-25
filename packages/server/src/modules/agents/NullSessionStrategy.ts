import type { ISessionStrategy } from './SessionStrategy';
import type { ServerConfig } from '../servers/Server';
import { buildWorkerLaunch } from './LaunchCommand';
import type { WorkerLaunch } from './WorkerLaunch';

export class NullSessionStrategy implements ISessionStrategy {
  readonly supportsSession = false;
  readonly needsPostLaunchScan = false;

  constructor(private workerType: string | null) {}

  buildNewSessionArgs(_sessionId: string): string[] {
    return [];
  }

  buildResumeArgs(_sessionId: string): string[] {
    return [];
  }

  buildRespawnLaunch(_agentSessionId: string | null, model: string | null, extraArgs: string | null, _blockMcp?: boolean): WorkerLaunch | null {
    return buildWorkerLaunch(this.workerType, model, extraArgs);
  }

  async scanSessionId(_server: ServerConfig, _workingDirectory: string | null, _afterTimestamp?: Date): Promise<string | null> {
    return null;
  }
}
