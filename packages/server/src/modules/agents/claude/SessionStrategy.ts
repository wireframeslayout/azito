import type { ISessionStrategy, RespawnConversation } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { findFilesByMtime, SESSION_SCAN_BUDGET_MS } from '../sessionScanUtils';
import { pathApiFor } from '../../../shared/os/hostPath';
import type { WorkerLaunch } from '../WorkerLaunch';
import { buildClaudeLaunch } from './launchCommand';
import { claudeProjectDirNames } from './projectDirName';
import { claudeConfigDirOf, type LocalAgentHomes } from '../agentHomes';

export class ClaudeSessionStrategy implements ISessionStrategy {
  readonly supportsSession = true;
  readonly needsPostLaunchScan = false;
  /** Claude creates the conversation file at the first message, so a window never typed into has an id but no file (#542). */
  readonly conversationLogAgentType = 'claude';

  constructor(private transportFactory: TransportFactory, private localHomes: LocalAgentHomes) {}

  buildNewSessionArgs(sessionId: string): string[] {
    return ['--session-id', sessionId];
  }

  buildResumeArgs(sessionId: string): string[] {
    // `--resume <id>` resumes that session. Combining `--session-id` with
    // `--resume` is rejected by current Claude Code ("--session-id can only be
    // used with --continue or --resume if --fork-session is also specified"),
    // which made every follow-up into a closed/sleeping window exit at launch.
    return ['--resume', sessionId];
  }

  buildRespawnLaunch(agentSessionId: string | null, model: string | null, extraArgs: string | null, blockMcp = true, conversation: RespawnConversation = 'resume'): WorkerLaunch {
    return buildClaudeLaunch({ model, extraArgs, blockMcp }, agentSessionId, conversation === 'new');
  }

  async scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null> {
    if (!workingDirectory) return null;
    const files = this.transportFactory.getFileOps(server);
    const configDir = await claudeConfigDirOf(files, server.type === 'local', this.localHomes);
    const deadline = Date.now() + SESSION_SCAN_BUDGET_MS;
    const found = [];
    for (const dirName of claudeProjectDirNames(files.platform, workingDirectory)) {
      const projectDir = pathApiFor(files.platform).join(configDir, 'projects', dirName);
      for (const file of await findFilesByMtime(files, projectDir, (name) => name.endsWith('.jsonl'), afterTimestamp, deadline)) found.push(file);
    }
    const candidates = found.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const latest = candidates[candidates.length - 1];
    if (!latest) return null;

    const match = latest.path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return match ? match[1] : null;
  }
}
