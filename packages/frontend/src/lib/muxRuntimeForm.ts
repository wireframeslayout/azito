import type { MuxRuntime } from '@azito/shared';

/**
 * Runtimes the server form offers. misao is experimental: only local servers (agent/ssh stay on tmux), and only
 * when the hub reports AZITO_EXPERIMENTAL_MISAO (GET /api/health `experimentalMisao`). A server already stored on
 * misao keeps the option even while the flag is unknown (health not loaded / failed) or off, so that opening its
 * edit form never silently turns the selection into system.
 */
export function muxRuntimeOptions(serverType: string, misaoEnabled: boolean, storedRuntime?: string): MuxRuntime[] {
  const offersMisao = serverType === 'local' && (misaoEnabled || storedRuntime === 'misao');
  return offersMisao ? ['system', 'managed', 'misao'] : ['system', 'managed'];
}

/** What the runtime field tells the user about the selection: entering misao, leaving it, or moving between tmux sockets. */
export type MuxRuntimeNotice = 'enterMisao' | 'leaveMisao' | 'tmuxMigration';

/** `original` is the persisted runtime (undefined while adding a server). */
export function muxRuntimeNotice(original: MuxRuntime | undefined, value: MuxRuntime): MuxRuntimeNotice | null {
  if (value === 'misao') return 'enterMisao';
  if (original === 'misao') return 'leaveMisao';
  if (original && original !== value) return 'tmuxMigration';
  return null;
}

/** A stored runtime the form does not offer (e.g. misao on a non-local server) starts as system. */
export function editableMuxRuntime(runtime: string | undefined, options: readonly MuxRuntime[]): MuxRuntime {
  return options.find((option) => option === runtime) ?? 'system';
}
