import type { ISessionStrategy } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { buildFindLatestByMtime } from '../sessionScanUtils';
import { shellQuote } from '../../../shared/shellQuote';
import { buildClaudeLaunchCommand } from './launchCommand';

export class ClaudeSessionStrategy implements ISessionStrategy {
  readonly supportsSession = true;
  readonly needsPostLaunchScan = false;

  constructor(private transportFactory: TransportFactory) {}

  buildNewSessionFlags(sessionId: string): string {
    return `--session-id ${sessionId}`;
  }

  buildResumeFlags(sessionId: string): string {
    return `--session-id ${sessionId} --resume`;
  }

  buildRespawnCommand(agentSessionId: string | null, model: string | null, extraArgs: string | null): string | null {
    if (agentSessionId) {
      const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
      const extra = extraArgs?.trim() ? ` ${extraArgs.trim()}` : '';
      // --strict-mcp-config: same MCP lockdown as buildClaudeLaunchCommand
      // (Issue #28 design v3 §3) — a `--resume` relaunch is still a task
      // worker pane, not a human-driven terminal.
      return `claude --resume ${agentSessionId} --dangerously-skip-permissions --strict-mcp-config${modelFlag}${extra}`;
    }
    return buildClaudeLaunchCommand({ model, extraArgs });
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
