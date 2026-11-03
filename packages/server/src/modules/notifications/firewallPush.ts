import type { FirewallDiagnosis } from '../servers/agent-deploy/AgentRecoveryWatchdog';
import type { SqlitePushSubscriptionRepository } from './SqlitePushSubscriptionRepository';
import type { PushNotificationService } from './push/PushNotificationService';
import { getPushMessage } from './push/pushCatalog';

export async function notifyFirewallPush(
  serverName: string,
  diagnosis: FirewallDiagnosis,
  subscriptions: Pick<SqlitePushSubscriptionRepository, 'findAll'>,
  push: Pick<PushNotificationService, 'sendToAll'>,
): Promise<void> {
  if (diagnosis.state === 'unknown') return;
  const key = diagnosis.state === 'blocked' ? 'firewall.blocked' : 'firewall.missing_allow';
  await push.sendToAll(subscriptions.findAll(), (sub) => ({
    ...getPushMessage(sub.lang, key, { serverName, rules: diagnosis.blockedBy.join(', '), commands: diagnosis.commands.join('\n') }),
    data: { url: '/', serverName },
  }));
}
