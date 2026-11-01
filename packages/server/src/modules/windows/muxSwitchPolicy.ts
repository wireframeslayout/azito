import type { MuxDriverKind } from '@azito/shared';
import type { MuxSwitchPolicy } from './SqliteMuxSwitchSettingsRepository';

export function shouldAskMuxSwitch(kind: MuxDriverKind, policy: MuxSwitchPolicy, available: boolean): boolean {
  return kind === 'tmux' && policy === 'ask' && available;
}

export function selectAutoWakeMux(kind: MuxDriverKind, policy: MuxSwitchPolicy, available: boolean): MuxDriverKind {
  return kind === 'tmux' && policy === 'misao' && available ? 'misao' : kind;
}

import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { ServerConfig } from '../servers/Server';

export function misaoStatusFor(registry: MuxDriverRegistry, server: ServerConfig) {
  const availability = registry.availabilityFor('misao', server);
  const hosted = registry.supportedKinds(server).includes('misao') && (availability.available || !['not_installed', 'driver_not_registered', 'unsupported_os'].includes(availability.reason));
  return { hosted, available: hosted && availability.available, ...(!availability.available ? { reason: availability.reason } : !hosted ? { reason: 'not_installed' as const } : {}) };
}

export function decideAutoWake(source: MuxDriverKind, actual: MuxDriverKind, policy: MuxSwitchPolicy, available: boolean): 'ask' | 'misao_unavailable' | null {
  if (source !== 'tmux' || actual !== 'tmux' || policy === 'tmux') return null;
  return available ? 'ask' : policy === 'misao' ? 'misao_unavailable' : null;
}

export class WindowBusyError extends Error {}
export class UnsupportedMuxSwitchError extends Error {}
