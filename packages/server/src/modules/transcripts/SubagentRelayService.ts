import { asPaneHandle, isRelayRoutingName } from '@azito/shared';
import type { Window } from '../windows/Window';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { WindowInputService } from './WindowInputService';
import type { WindowSessionResolver } from './WindowSessionResolver';

type RelaySource = TranscriptSource & Required<Pick<TranscriptSource, 'listSubagents'>>;
type RelayResult = { status: number; body: { error: string; code?: string } } | { status: 200; body: { ok: true } };

export class SubagentRelayService {
  private readonly inFlight = new Set<number>();
  constructor(private readonly resolver: WindowSessionResolver, private readonly input: WindowInputService) {}

  async relay(window: Window, sessionId: string, paneId: string, agentId: string, text: string, sourceFor: () => RelaySource | null): Promise<RelayResult | null> {
    const reject = (error: string, status = 409): RelayResult => ({ status, body: { error } });
    if (this.inFlight.has(window.id)) return reject('relay_busy');
    this.inFlight.add(window.id);
    try {
      const resolved = await this.resolver.resolve(window);
      if (!resolved.resolved || resolved.agentType !== 'claude' || resolved.sessionId !== sessionId || resolved.paneId !== paneId || !resolved.agentDetected) return reject('parent_session_changed');
      const paneIndex = await this.input.resolvePaneIndex(window.id, paneId);
      const matches = window.paneLayout?.panes.filter(pane => pane.agentSessionId === sessionId) ?? [];
      const verified = typeof paneIndex === 'number' && matches.length === 1 && matches[0].index === paneIndex || matches.length === 0 && window.agentSessionId === sessionId && await this.input.isOnlyPane(window.id, asPaneHandle(paneId));
      if (!verified) return reject('pane_session_unverified');
      const source = sourceFor();
      if (!source) return null;
      const agents = await source.listSubagents(sessionId);
      const agent = agents?.find(item => item.id === agentId);
      if (!agent) return reject('subagent_unavailable');
      if (agent.routingName === undefined) return reject('agent_outdated', 501);
      if (agent.status === 'finished' || !isRelayRoutingName(agent.routingName, agents!.map(item => item.routingName))) return reject('subagent_unavailable');
      const tail = await source.getSessionTailState(sessionId);
      if (!['terminal_final', 'terminal_interrupted', 'terminal_local'].includes(tail.state)) return { status: 409, body: { code: 'parent_busy', error: 'The parent is working or its state cannot be verified.' } };
      const result = await this.input.sendRelayInput(window.id, asPaneHandle(paneId), `Please relay the following message to subagent ${JSON.stringify(agent.routingName)}:\n\n${text}`);
      if (result !== 'ok') return { status: 409, body: typeof result === 'object' ? result : { error: result } };
      return { status: 200, body: { ok: true } };
    } finally { this.inFlight.delete(window.id); }
  }
}
