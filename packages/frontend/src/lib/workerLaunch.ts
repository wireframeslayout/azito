import type { HostFeature } from '@azito/shared';

/** What is being added: `mode` and `agent` as the Add Window form (and the quick add) hold them. */
export interface AddWindowRequest {
  mode: 'existing' | 'session' | 'new';
  serverName: string;
  /** The coding agent chosen for a new window: 'none' (a plain shell), 'custom', or an agent type (claude / codex). */
  agent: string;
}

/**
 * Why this request must not be sent, or null when it may. A new window that starts an agent or a command needs a pane
 * command, which a Windows pane does not take yet (`workerLaunch`); a plain shell, and registering an existing window or
 * session, need none. The Add Window form, the quick add and the shared submit all judge with this one function.
 */
export function workerLaunchBlock(request: AddWindowRequest, blockReasonFor: (serverName: string, feature: HostFeature) => string | null): string | null {
  if (request.mode !== 'new' || request.agent === 'none') return null;
  return blockReasonFor(request.serverName, 'workerLaunch');
}
