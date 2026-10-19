import type { ISessionStrategy } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { buildFindLatestByMtime } from '../sessionScanUtils';
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
    const transport = this.transportFactory.getTransport(server);
    const normalized = workingDirectory.replace(/\/+$/, '');
    const encoded = normalized.replace(/[/.]/g, '-');

    const cmd = buildFindLatestByMtime(`~/.claude/projects/${encoded}/`, '*.jsonl', afterTimestamp);

    const result = await transport.exec(cmd);
    const filePath = result.stdout.trim();
    if (!filePath) return null;

    const match = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return match ? match[1] : null;
  }
}
