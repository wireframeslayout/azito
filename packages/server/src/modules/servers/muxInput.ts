import type { MuxDriverKind } from '@azito/shared';
import type { MuxRuntime } from './Server';

export type MuxInputResult =
  | { ok: true; defaultMux?: MuxDriverKind; muxRuntime?: MuxRuntime }
  | { ok: false; error: string };

const DEFAULT_MUX_VALUES: readonly string[] = ['tmux', 'misao'];
const MUX_RUNTIME_VALUES: readonly string[] = ['system', 'managed'];

/**
 * Validates the mux fields of a server create/update body: `defaultMux` (the mux kind) and `muxRuntime`
 * (the tmux binary). An empty value means "not given".
 *
 * Compatibility, to be removed one release after v0.11.0: before `defaultMux` existed, the misao mux was
 * selected with `muxRuntime: 'misao'`. That input is still accepted and read as `defaultMux: 'misao'`
 * (the tmux runtime is then left as given/unchanged).
 */
export function parseMuxInput(body: { defaultMux?: unknown; muxRuntime?: unknown }): MuxInputResult {
  let defaultMux = body.defaultMux || undefined;
  let muxRuntime = body.muxRuntime || undefined;
  if (defaultMux !== undefined && (typeof defaultMux !== 'string' || !DEFAULT_MUX_VALUES.includes(defaultMux))) {
    return { ok: false, error: 'defaultMux must be "tmux" or "misao"' };
  }
  if (muxRuntime === 'misao') {
    if (defaultMux !== undefined && defaultMux !== 'misao') {
      return { ok: false, error: 'muxRuntime "misao" conflicts with defaultMux "tmux"' };
    }
    defaultMux = 'misao';
    muxRuntime = undefined;
  }
  if (muxRuntime !== undefined && (typeof muxRuntime !== 'string' || !MUX_RUNTIME_VALUES.includes(muxRuntime))) {
    return { ok: false, error: 'muxRuntime must be "system" or "managed"' };
  }
  return { ok: true, defaultMux: defaultMux as MuxDriverKind | undefined, muxRuntime: muxRuntime as MuxRuntime | undefined };
}
