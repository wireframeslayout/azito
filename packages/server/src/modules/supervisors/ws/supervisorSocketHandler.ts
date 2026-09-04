import type { WebSocket } from 'ws';
import type { SupervisorRegistry } from '../SupervisorRegistry';
import type { RegisterMessage, SupervisorToHubMessage } from '../protocol';

/**
 * Hand-rolled shape validation for the `register` message, matching the
 * validation style of modules/notifications/webhooks.ts (no schema library
 * in this codebase for hub<->agent/supervisor boundary payloads).
 */
function validateRegisterMessage(raw: Record<string, unknown>): RegisterMessage | null {
  if (typeof raw.protocolVersion !== 'number') return null;
  if (typeof raw.serverName !== 'string' || raw.serverName === '') return null;
  if (typeof raw.target !== 'string' || raw.target === '') return null;
  if (raw.taskId !== null && typeof raw.taskId !== 'number') return null;
  if (raw.unitId !== null && typeof raw.unitId !== 'number') return null;
  if (typeof raw.pid !== 'number') return null;
  if (typeof raw.childCommand !== 'string') return null;
  if (raw.launchId !== undefined && typeof raw.launchId !== 'string') return null;
  if (raw.bootstrapToken !== undefined && typeof raw.bootstrapToken !== 'string') return null;
  if (raw.sessionToken !== undefined && typeof raw.sessionToken !== 'string') return null;

  return {
    type: 'register',
    protocolVersion: raw.protocolVersion,
    serverName: raw.serverName,
    target: raw.target,
    taskId: raw.taskId as number | null,
    unitId: raw.unitId as number | null,
    pid: raw.pid,
    childCommand: raw.childCommand,
    // Anything other than the literal `true` (including undefined — supervisors predating this
    // field) is treated as "does not report ready"; only an exact `true` is passed through.
    ...(raw.reportsReady === true ? { reportsReady: true as const } : {}),
    ...(typeof raw.launchId === 'string' ? { launchId: raw.launchId } : {}),
    ...(typeof raw.bootstrapToken === 'string' ? { bootstrapToken: raw.bootstrapToken } : {}),
    ...(typeof raw.sessionToken === 'string' ? { sessionToken: raw.sessionToken } : {}),
    ...(typeof raw.muxPaneRef === 'string' && /^%\d+$/.test(raw.muxPaneRef) ? { muxPaneRef: raw.muxPaneRef } : {}),
  };
}

/**
 * Wires a newly-accepted `/ws/supervisor` connection to the registry. Purely
 * routing: parses each frame, validates the `register` message's shape, and
 * forwards everything else to SupervisorRegistry — all state and business
 * logic (ack matching, heartbeat, ping/pong, event emission) live there.
 */
export function handleSupervisorConnection(socket: WebSocket, registry: SupervisorRegistry): void {
  socket.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      console.warn('[supervisors] received malformed JSON, ignoring');
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[supervisors] received non-object message, ignoring');
      return;
    }

    const msg = parsed as Record<string, unknown>;
    if (msg.type === 'register') {
      const validated = validateRegisterMessage(msg);
      if (!validated) {
        console.warn('[supervisors] received invalid register message, ignoring');
        return;
      }
      registry.register(socket, validated);
      return;
    }

    if (typeof msg.type !== 'string') {
      return; // unknown/malformed — ignored per protocol forward-compatibility
    }
    registry.handleMessage(socket, msg as unknown as SupervisorToHubMessage);
  });

  socket.on('close', () => {
    registry.handleSocketClosed(socket);
  });

  socket.on('error', () => {
    // Swallow — 'close' follows and drives cleanup (mirrors HubClient's own pattern).
  });
}
