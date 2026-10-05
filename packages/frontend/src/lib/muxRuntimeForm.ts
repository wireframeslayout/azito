import type { MuxDriverKind, MuxRuntime } from '@azito/shared';

/** The tmux binaries a server can run (every server, whatever its default mux). */
export const TMUX_RUNTIME_OPTIONS: readonly MuxRuntime[] = ['system', 'managed'];

/**
 * Default mux kinds the server form offers: a local and an agent server can both run misao (an agent's through its
 * agent, installed with it) or tmux. Any other type stays on tmux.
 */
export function defaultMuxOptions(serverType: string): MuxDriverKind[] {
  return serverType === 'local' || serverType === 'agent' ? ['misao', 'tmux'] : ['tmux'];
}

/** What the default-mux field tells the user about the selection: entering misao or leaving it. */
export type DefaultMuxNotice = 'enterMisao' | 'leaveMisao';

/** `original` is the persisted default mux (undefined while adding a server). */
export function defaultMuxNotice(original: MuxDriverKind | undefined, value: MuxDriverKind): DefaultMuxNotice | null {
  if (value === original) return null;
  if (value === 'misao') return 'enterMisao';
  if (original === 'misao') return 'leaveMisao';
  return null;
}

/** Moving between tmux binaries leaves the sessions on the previous socket behind. `original` is undefined while adding. */
export function tmuxRuntimeNotice(original: MuxRuntime | undefined, value: MuxRuntime): 'tmuxMigration' | null {
  return original && original !== value ? 'tmuxMigration' : null;
}

/** A stored default mux the form does not offer starts as tmux. */
export function editableDefaultMux(stored: MuxDriverKind, options: readonly MuxDriverKind[]): MuxDriverKind {
  return options.find((option) => option === stored) ?? 'tmux';
}

/** A stored tmux runtime the form does not offer starts as system. */
export function editableMuxRuntime(runtime: string | undefined): MuxRuntime {
  return TMUX_RUNTIME_OPTIONS.find((option) => option === runtime) ?? 'system';
}
