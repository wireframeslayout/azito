import type { ISessionStrategy, RespawnConversation } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import { raceDeadline } from '../../../shared/fs/deadline';
import { pathApiFor } from '../../../shared/os/hostPath';
import { findFilesByMtime, firstLineOf, normalizeCwd, parseRolloutMeta, ROLLOUT_HEAD_BYTES, SESSION_SCAN_BUDGET_MS, type RolloutCandidate } from '../sessionScanUtils';
import { codexHomeOf, type LocalAgentHomes } from '../agentHomes';
import type { WorkerLaunch } from '../WorkerLaunch';
import { buildCodexLaunch, buildCodexRespawnLaunch } from './launchCommand';

export class CodexSessionStrategy implements ISessionStrategy {
  readonly supportsSession = true;
  readonly needsPostLaunchScan = true;
  private excludedIds = new Set<string>();

  constructor(private transportFactory: TransportFactory, private localHomes: LocalAgentHomes) {}

  excludeSessionId(id: string): void {
    this.excludedIds.add(id);
  }

  buildNewSessionArgs(_sessionId: string): string[] {
    return [];
  }

  buildResumeArgs(sessionId: string): string[] {
    return ['resume', sessionId];
  }

  buildRespawnLaunch(agentSessionId: string | null, model: string | null, extraArgs: string | null, blockMcp = true): WorkerLaunch {
    if (agentSessionId) {
      return buildCodexRespawnLaunch(agentSessionId, { model, extraArgs, blockMcp });
    }
    return buildCodexLaunch({ model, extraArgs, blockMcp });
  }

  /**
   * Always `resume`: a Codex session id only ever comes from {@link scanSessionId}, which reads it out of a rollout file that already
   * exists, so a recorded id has had its conversation file (Codex has no way to be started under a chosen id either).
   */
  async resolveRespawnConversation(_server: ServerConfig, _workingDirectory: string | null, _sessionId: string): Promise<RespawnConversation> {
    return 'resume';
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
