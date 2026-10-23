import type { ISessionStrategy } from './SessionStrategy';
import type { ServerConfig } from '../servers/Server';
import { buildWorkerLaunchCommand } from './LaunchCommand';
import type { ShellDialect } from '../../shared/os/shellDialect';

export class NullSessionStrategy implements ISessionStrategy {
  readonly supportsSession = false;
  readonly needsPostLaunchScan = false;

  constructor(private workerType: string | null) {}

  buildNewSessionFlags(_sessionId: string): string {
    return '';
  }

  buildResumeFlags(_sessionId: string): string {
    return '';
  }

  buildRespawnCommand(_agentSessionId: string | null, model: string | null, extraArgs: string | null, dialect: ShellDialect, _blockMcp?: boolean): string | null {
    return buildWorkerLaunchCommand(this.workerType, model, extraArgs, dialect);
  }

  async scanSessionId(_server: ServerConfig, _workingDirectory: string | null, _afterTimestamp?: Date): Promise<string | null> {
    return null;
  }
}
