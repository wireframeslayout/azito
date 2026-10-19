import type { ISessionStrategy } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { findFilesByMtime, SESSION_SCAN_BUDGET_MS } from '../sessionScanUtils';
import { pathApiFor } from '../../../shared/os/hostPath';
import type { ShellDialect } from '../../../shared/os/shellDialect';
import { buildClaudeLaunchCommand } from './launchCommand';

export class ClaudeSessionStrategy implements ISessionStrategy {
  readonly supportsSession = true;
  readonly needsPostLaunchScan = false;

  constructor(private transportFactory: TransportFactory) {}

  buildNewSessionFlags(sessionId: string): string {
    return `--session-id ${sessionId}`;
  }

  buildResumeFlags(sessionId: string): string {
    // `--resume <id>` resumes that session. Combining `--session-id` with
    // `--resume` is rejected by current Claude Code ("--session-id can only be
    // used with --continue or --resume if --fork-session is also specified"),
    // which made every follow-up into a closed/sleeping window exit at launch.
    return `--resume ${sessionId}`;
  }

  buildRespawnCommand(agentSessionId: string | null, model: string | null, extraArgs: string | null, dialect: ShellDialect, blockMcp = true): string | null {
    if (agentSessionId) {
      const mcpFlag = blockMcp ? ' --strict-mcp-config' : '';
      const modelFlag = model ? ` --model ${dialect.quote(model)}` : '';
      const extra = extraArgs?.trim() ? ` ${extraArgs.trim()}` : '';
      return `claude --resume ${agentSessionId} --dangerously-skip-permissions${mcpFlag}${modelFlag}${extra}`;
    }
    return buildClaudeLaunchCommand({ model, extraArgs, blockMcp, dialect });
  }

  async scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null> {
    if (!workingDirectory) return null;
    const files = this.transportFactory.getFileOps(server);
    const normalized = workingDirectory.replace(/\/+$/, '');
    const encoded = normalized.replace(/[/.]/g, '-');

    const projectDir = pathApiFor(files.platform).join(await files.realpath('~'), '.claude', 'projects', encoded);
    const candidates = await findFilesByMtime(files, projectDir, (name) => name.endsWith('.jsonl'), afterTimestamp, Date.now() + SESSION_SCAN_BUDGET_MS);
    const latest = candidates[candidates.length - 1];
    if (!latest) return null;

    const match = latest.path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return match ? match[1] : null;
  }
}
