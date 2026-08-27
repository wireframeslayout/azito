import type { SqliteAgentWatchRepository } from './SqliteAgentWatchRepository';
import type { SqlitePushSubscriptionRepository } from './SqlitePushSubscriptionRepository';
import type { PushNotificationService } from './push/PushNotificationService';
import { getPushMessage } from './push/pushCatalog';
import { agentPushUrl } from './push/pushLinks';

export interface AgentActivityBridgePayload {
  serverName: string;
  target: string;
  running: boolean;
  label?: string;
}

export interface AgentWatchBridgeDeps {
  agentWatchRepo: Pick<SqliteAgentWatchRepository, 'findByKey' | 'deleteById'>;
  pushSubRepo: Pick<SqlitePushSubscriptionRepository, 'findByEndpoint'>;
  pushService: Pick<PushNotificationService, 'sendToAll'>;
}

// Sends an "AZITO: Agent Idle" push notification to every one-shot watch
// registered for a server/target pane once it goes idle (`running: false`),
// then deletes the watch row regardless of send success.
//
// Design decision: a failed push send still consumes the watch. Silently
// losing a single idle notification is judged less harmful than a watch that
// never clears and re-fires (or worse, is retried indefinitely) after a
// transient push provider error.
export async function notifyAgentWatchesOnIdle(
  payload: AgentActivityBridgePayload,
  deps: AgentWatchBridgeDeps,
): Promise<void> {
  if (payload.running) return;

  const watches = deps.agentWatchRepo.findByKey(payload.serverName, payload.target);
  if (watches.length === 0) return;

  for (const watch of watches) {
    const sub = deps.pushSubRepo.findByEndpoint(watch.endpoint);
    if (sub) {
      try {
        await deps.pushService.sendToAll([sub], (s) => ({
          ...getPushMessage(s.lang, 'agent.idle', {
            label: watch.label ?? payload.label ?? payload.target,
            serverName: payload.serverName,
          }),
          data: { url: agentPushUrl({ serverName: payload.serverName, target: payload.target }) },
        }));
      } catch {
        // ignore — watch is still deleted below (see design decision above)
      }
    }
    deps.agentWatchRepo.deleteById(watch.id);
  }
}
