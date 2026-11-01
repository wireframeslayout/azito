import type { MuxDriverKind } from '@azito/shared';
import type { MuxSwitchPolicy } from './SqliteMuxSwitchSettingsRepository';

export function shouldAskMuxSwitch(kind: MuxDriverKind, policy: MuxSwitchPolicy, available: boolean): boolean {
  return kind === 'tmux' && policy === 'ask' && available;
}

export function selectAutoWakeMux(kind: MuxDriverKind, policy: MuxSwitchPolicy, available: boolean): MuxDriverKind {
  return kind === 'tmux' && policy === 'misao' && available ? 'misao' : kind;
}
