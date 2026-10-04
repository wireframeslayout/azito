import type { MuxDriverKind } from '@azito/shared';
import { defaultMuxOptions } from './muxRuntimeForm';
import type { UnavailableMuxKind } from './fetchServerSessions';

/** i18n keys (`workspace:addWindow.muxReason.*`) of why a kind cannot be picked right now. */
export type MuxKindReason = 'misaoUnreachable' | 'misaoIncompatible' | 'misaoNotRegistered' | 'tmuxMissing' | 'unavailable';

export interface MuxKindAvailability {
  ok: boolean;
  reason?: MuxKindReason;
}

export type MuxAvailabilityMap = Record<MuxDriverKind, MuxKindAvailability>;

/** Where the "which kinds can this server use right now" check stands (`GET /sessions?detail=1`). */
export type MuxAvailabilityState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; unavailable: readonly UnavailableMuxKind[] };

/** The kinds a server offers for a new window: both on a local server, tmux only elsewhere. */
export function selectableMuxKinds(server: { type: string }): MuxDriverKind[] {
  return defaultMuxOptions(server.type);
}

/** Why `kind` is down, as the hub reported it. A reason this UI does not know reads as a generic "unavailable". */
export function muxKindReason(kind: MuxDriverKind, hubReason: string): MuxKindReason {
  if (kind === 'tmux') return 'tmuxMissing';
  switch (hubReason) {
    case 'daemon_unreachable': return 'misaoUnreachable';
    case 'protocol_incompatible': return 'misaoIncompatible';
    case 'driver_not_registered': return 'misaoNotRegistered';
    default: return 'unavailable';
  }
}

/** Per-kind availability from the listing's `unavailable`. While the check runs or when it failed, no kind is ruled out (the hub still refuses with 409). */
export function muxKindAvailability(state: MuxAvailabilityState): MuxAvailabilityMap {
  const map: MuxAvailabilityMap = { tmux: { ok: true }, misao: { ok: true } };
  if (state.status !== 'ready') return map;
  for (const { kind, reason } of state.unavailable) map[kind] = { ok: false, reason: muxKindReason(kind, reason) };
  return map;
}

/** The kind a new window starts on: the server's default, or the other one when the default is down. */
export function initialMuxKind(defaultMux: MuxDriverKind, availability: MuxAvailabilityMap, kinds: readonly MuxDriverKind[]): MuxDriverKind {
  if (availability[defaultMux].ok) return defaultMux;
  return kinds.find((kind) => availability[kind].ok) ?? defaultMux;
}

/** The kind to create the window in: the user's pick while it is still usable, else the initial one. `choice` is null until the user picks. */
export function effectiveMuxKind(
  choice: MuxDriverKind | null,
  defaultMux: MuxDriverKind,
  availability: MuxAvailabilityMap,
  kinds: readonly MuxDriverKind[],
): MuxDriverKind {
  if (choice && kinds.includes(choice) && availability[choice].ok) return choice;
  return initialMuxKind(defaultMux, availability, kinds);
}

/** What the select shows: hidden when the server offers one kind only. */
export interface MuxKindSelectModel {
  visible: boolean;
  kinds: MuxDriverKind[];
  value: MuxDriverKind;
  availability: MuxAvailabilityMap;
  loading: boolean;
  checkFailed: boolean;
}

export function muxKindSelectModel(
  server: { type: string; defaultMux: MuxDriverKind },
  state: MuxAvailabilityState,
  choice: MuxDriverKind | null,
): MuxKindSelectModel {
  const kinds = selectableMuxKinds(server);
  const availability = muxKindAvailability(state);
  return {
    visible: kinds.length > 1,
    kinds,
    value: effectiveMuxKind(choice, server.defaultMux, availability, kinds),
    availability,
    loading: state.status === 'loading',
    checkFailed: state.status === 'error',
  };
}

/** The hub's 409 for a kind the server cannot use (`POST /mux/workspaces[/:ws/windows]` with `kind`). */
export function isMuxKindUnavailable(res: unknown): res is { error: 'mux_kind_unavailable'; kind: MuxDriverKind; reason: string } {
  if (typeof res !== 'object' || res === null) return false;
  const r = res as Record<string, unknown>;
  return r['error'] === 'mux_kind_unavailable' && (r['kind'] === 'tmux' || r['kind'] === 'misao') && typeof r['reason'] === 'string';
}
