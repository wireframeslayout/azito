export type EditableMuxRuntime = 'system' | 'managed';

/** The server form only offers system/managed; any other stored runtime (e.g. an experimental one) starts as system. */
export function editableMuxRuntime(runtime: string | undefined): EditableMuxRuntime {
  return runtime === 'managed' ? 'managed' : 'system';
}
