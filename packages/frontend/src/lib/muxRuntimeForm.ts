import type { MuxRuntime } from '@azito/shared';

/**
 * Runtimes the server form offers. misao is experimental: only local servers (agent/ssh stay on tmux), and only
 * when the hub reports AZITO_EXPERIMENTAL_MISAO (GET /api/health `experimentalMisao`).
 */
export function muxRuntimeOptions(serverType: string, misaoEnabled: boolean): MuxRuntime[] {
  return serverType === 'local' && misaoEnabled ? ['system', 'managed', 'misao'] : ['system', 'managed'];
}

/** A stored runtime the form does not offer (e.g. misao while the flag is off) starts as system. */
export function editableMuxRuntime(runtime: string | undefined, options: readonly MuxRuntime[]): MuxRuntime {
  return options.find((option) => option === runtime) ?? 'system';
}
