import type { ISessionStrategy, RespawnConversation } from '../SessionStrategy';
import { ConversationCheckError } from '../ConversationCheckError';
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

  /**
   * Claude creates `<config dir>/projects/<cwd>/<id>.jsonl` at the first message, so a window that was never typed into has an id
   * but no file, and `--resume` of it exits with "No conversation found". The location is the one {@link scanSessionId} reads.
   * The file is looked for only (a stat, not its content): found = `resume`, absent in every possible folder = `new`, anything
   * that stops the host from answering is a {@link ConversationCheckError}.
   */
  async resolveRespawnConversation(server: ServerConfig, workingDirectory: string | null, sessionId: string): Promise<RespawnConversation> {
    if (!workingDirectory) throw new ConversationCheckError(sessionId, '窓の作業ディレクトリが分からず、会話の置き場所を決められません');
    try {
      const files = this.transportFactory.getFileOps(server);
      const configDir = await claudeConfigDirOf(files, server.type === 'local', this.localHomes);
      const api = pathApiFor(files.platform);
      for (const dirName of claudeProjectDirNames(files.platform, workingDirectory)) {
        const file = api.join(configDir, 'projects', dirName, `${sessionId}.jsonl`);
        const stat = await files.stat(file);
        if (stat === null) continue;
        if (stat.kind !== 'file') throw new Error(`${file} は通常のファイルではありません`);
        return 'resume';
      }
      return 'new';
    } catch (err) {
      if (err instanceof ConversationCheckError) throw err;
      throw new ConversationCheckError(sessionId, err instanceof Error ? err.message : String(err));
    }
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
