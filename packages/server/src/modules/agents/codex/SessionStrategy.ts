import type { ISessionStrategy } from '../SessionStrategy';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { buildListCandidatesWithMeta, normalizePath, parseCandidates } from '../sessionScanUtils';
import { shellQuote } from '../shellQuote';
import { buildCodexLaunchCommand } from './launchCommand';

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

  buildRespawnCommand(agentSessionId: string | null, model: string | null, extraArgs: string | null): string | null {
    if (agentSessionId) {
      const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
      const extra = extraArgs?.trim() ? ` ${extraArgs.trim()}` : '';
      return `codex resume ${agentSessionId} --dangerously-bypass-approvals-and-sandbox${modelFlag}${extra}`;
    }
    return buildCodexLaunchCommand({ model, extraArgs });
  }

  async scanSessionId(server: ServerConfig, workingDirectory: string | null, afterTimestamp?: Date): Promise<string | null> {
    const transport = this.transportFactory.getTransport(server);

    const cmd = buildListCandidatesWithMeta('~/.codex/sessions/', 'rollout-*.jsonl', afterTimestamp);

    const result = await transport.exec(cmd);
    const candidates = parseCandidates(result.stdout);
    const filtered = candidates.filter((candidate) => {
      if (this.excludedIds.has(candidate.sessionId)) return false;
      if (candidate.originator === 'codex_exec') return false;
      if (workingDirectory !== null && candidate.cwd !== null) {
        return normalizePath(candidate.cwd) === normalizePath(workingDirectory);
      }
      return true;
    });
    return filtered[0]?.sessionId ?? null;
  }
}
