import type { ISessionStrategy } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';
import { findFilesByMtime, firstLineOf, normalizePath, parseRolloutMeta, ROLLOUT_HEAD_BYTES, type RolloutCandidate } from '../sessionScanUtils';
import type { ShellDialect } from '../../../shared/os/shellDialect';
import { buildCodexLaunchCommand, buildCodexRespawnCommand } from './launchCommand';

export class CodexSessionStrategy implements ISessionStrategy {
  readonly supportsSession = true;
  readonly needsPostLaunchScan = true;
  private excludedIds = new Set<string>();

  constructor(private transportFactory: TransportFactory) {}

  excludeSessionId(id: string): void {
    this.excludedIds.add(id);
  }

  buildNewSessionFlags(_sessionId: string): string {
    return '';
  }

  buildResumeFlags(sessionId: string): string {
    return `resume ${sessionId}`;
  }

  buildRespawnCommand(agentSessionId: string | null, model: string | null, extraArgs: string | null, dialect: ShellDialect, blockMcp = true): string | null {
    if (agentSessionId) {
      return buildCodexRespawnCommand(agentSessionId, { model, extraArgs, blockMcp, dialect });
    }
    return buildCodexLaunchCommand({ model, extraArgs, blockMcp, dialect });
  }

  async scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null> {
    const files = this.transportFactory.getFileOps(server);
    const sessionsDir = pathApiFor(files.platform).join(await files.realpath('~'), '.codex', 'sessions');

    // Oldest first; the first one that passes the filters is the answer, so the rest are not read.
    const rollouts = await findFilesByMtime(files, sessionsDir, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), afterTimestamp);
    for (const rollout of rollouts) {
      const candidate = await this.readCandidate(files, rollout.path);
      if (!candidate) continue;
      if (this.excludedIds.has(candidate.sessionId)) continue;
      if (candidate.originator === 'codex_exec') continue;
      if (workingDirectory !== null && candidate.cwd !== null && normalizePath(candidate.cwd) !== normalizePath(workingDirectory)) continue;
      return candidate.sessionId;
    }
    return null;
  }

  /** The rollout's session metadata, or null when the file vanished or its first line holds none (a missing file's `head -1` gave nothing either). */
  private async readCandidate(files: IFileOps, filePath: string): Promise<RolloutCandidate | null> {
    let head: Buffer;
    try {
      head = (await files.read(filePath, { headBytes: ROLLOUT_HEAD_BYTES })).data;
    } catch (err) {
      if (err instanceof FileOpsError) return null;
      throw err;
    }
    const line = firstLineOf(head);
    return line === null ? null : parseRolloutMeta(filePath, line);
  }
}
