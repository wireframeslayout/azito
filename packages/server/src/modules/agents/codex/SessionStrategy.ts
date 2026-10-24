import type { ISessionStrategy } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import { raceDeadline } from '../../../shared/fs/deadline';
import { pathApiFor } from '../../../shared/os/hostPath';
import { findFilesByMtime, firstLineOf, normalizeCwd, parseRolloutMeta, ROLLOUT_HEAD_BYTES, SESSION_SCAN_BUDGET_MS, type RolloutCandidate } from '../sessionScanUtils';
import type { ShellDialect } from '../../../shared/os/shellDialect';
import { codexHomeOf, type LocalAgentHomes } from '../agentHomes';
import { buildCodexLaunchCommand, buildCodexRespawnCommand } from './launchCommand';

export class CodexSessionStrategy implements ISessionStrategy {
  readonly supportsSession = true;
  readonly needsPostLaunchScan = true;
  private excludedIds = new Set<string>();

  constructor(private transportFactory: TransportFactory, private localHomes: LocalAgentHomes) {}

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
    const sessionsDir = pathApiFor(files.platform).join(await codexHomeOf(files, server.type === 'local', this.localHomes), 'sessions');

    // Oldest first; the first one that passes the filters is the answer, so the rest are not read. The reads share the scan's time.
    const deadline = Date.now() + SESSION_SCAN_BUDGET_MS;
    const rollouts = await findFilesByMtime(files, sessionsDir, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), afterTimestamp, deadline);
    for (const rollout of rollouts) {
      const candidate = await this.readCandidate(files, rollout.path, deadline);
      if (!candidate) continue;
      if (this.excludedIds.has(candidate.sessionId)) continue;
      if (candidate.originator === 'codex_exec') continue;
      if (workingDirectory !== null && candidate.cwd !== null && normalizeCwd(files.platform, candidate.cwd) !== normalizeCwd(files.platform, workingDirectory)) continue;
      return candidate.sessionId;
    }
    return null;
  }

  /** The rollout's session metadata, or null when the file vanished or its first line holds none (a missing file's `head -1` gave nothing either). */
  private async readCandidate(files: IFileOps, filePath: string, deadlineAtMs: number): Promise<RolloutCandidate | null> {
    let head: Buffer;
    try {
      head = (await raceDeadline(files.read(filePath, { headBytes: ROLLOUT_HEAD_BYTES }), deadlineAtMs, 'The session scan')).data;
    } catch (err) {
      if (err instanceof FileOpsError) return null;
      throw err;
    }
    const line = firstLineOf(head);
    return line === null ? null : parseRolloutMeta(filePath, line);
  }
}
