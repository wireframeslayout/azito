import { muxRefFromTmuxTarget, type MuxDriverKind, type MuxRef } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { MuxDriverRegistry } from './MuxDriverRegistry';
import { kindOfStoredWindow, type WindowRowIdentity } from './windowIdentity';

/** A window known only by name exists in more than one mux of the server, so its kind cannot be told. */
export class AmbiguousWindowKindError extends Error {
  constructor(public readonly window: string, public readonly kinds: MuxDriverKind[]) {
    super(`Window '${window}' exists in more than one mux (${kinds.join(', ')}); its kind cannot be told without a stored mux_ref`);
    this.name = 'AmbiguousWindowKindError';
  }
}

/**
 * The mux of a task's window. With a primary window row it is the row's `mux_ref` kind (tmux when the row has none:
 * rows predate misao). Without any row only the name in `task.tmuxWindow` is left, and a name says nothing about its
 * mux (`w_<ULID>` is a valid tmux window name too), so it is looked up:
 * - a server that hosts one mux only (an agent / ssh server): that mux;
 * - a server that hosts both: the mux(es) that have the window. Exactly one is that window's kind; both is
 *   {@link AmbiguousWindowKindError}; none (the window is gone) is tmux, the mux data without a ref predates misao in.
 *   A mux that cannot be asked (daemon down) makes "none" unknowable: its error is thrown rather than guessed around.
 * Every reader of stored data that has no primary row uses this one function.
 */
export async function resolveStoredWindowKind(
  registry: MuxDriverRegistry,
  server: ServerConfig,
  primaryWindow: Pick<WindowRowIdentity, 'muxRef'> | undefined,
  workspace: string,
  window: string | null,
): Promise<MuxDriverKind> {
  if (primaryWindow) return kindOfStoredWindow(primaryWindow);
  const kinds = registry.supportedKinds(server);
  if (window === null || kinds.length === 1) return kinds.length === 1 ? kinds[0] : 'tmux';

  const found: MuxDriverKind[] = [];
  let unknown: unknown;
  for (const kind of kinds) {
    try {
      if (await registry.resolveKind(kind, server).windowExists(server, { kind, workspace, window })) found.push(kind);
    } catch (err) {
      unknown ??= err;
    }
  }
  if (found.length > 1) throw new AmbiguousWindowKindError(window, found);
  if (found.length === 1) return found[0];
  if (unknown !== undefined) throw unknown;
  return 'tmux';
}

/** How a raw `<workspace>:<window>` string is looked up in the muxes of a server. */
export interface RawTargetProbe {
  supportedKinds(server: ServerConfig): MuxDriverKind[];
  /** The window `target` names in one mux of the server; null when it names no single window there or the mux cannot answer. */
  resolveRefInMux(server: ServerConfig, kind: MuxDriverKind, target: string): Promise<MuxRef | null>;
}

export function rawTargetProbeOf(registry: MuxDriverRegistry): RawTargetProbe {
  return {
    supportedKinds: (server) => registry.supportedKinds(server),
    resolveRefInMux: async (server, kind, target) => {
      try {
        return await registry.resolveKind(kind, server).resolveRef(server, target);
      } catch {
        return null; // driver unavailable or daemon down: not found there
      }
    },
  };
}

/**
 * The window a RAW `<workspace>:<window>` target (it comes from a client and carries no kind) names, with its kind.
 * A name says nothing about its mux, so a server that hosts both is asked: the mux that has the window decides; both
 * is {@link AmbiguousWindowKindError} (the client must name the window by windowId or ref); none is null. A server
 * that hosts one mux needs no question: a tmux target is a tmux ref as it is, a misao one must resolve in the daemon.
 * Registered windows are not looked up here: their row's `mux_ref` decides (see `kindOfStoredWindow`).
 */
export async function resolveRawTarget(probe: RawTargetProbe, server: ServerConfig, target: string): Promise<{ kind: MuxDriverKind; ref: MuxRef | null } | null> {
  const kinds = probe.supportedKinds(server);
  if (kinds.length === 1) {
    if (kinds[0] === 'tmux') return { kind: 'tmux', ref: muxRefFromTmuxTarget(target) };
    return { kind: kinds[0], ref: await probe.resolveRefInMux(server, kinds[0], target) };
  }
  const found: Array<{ kind: MuxDriverKind; ref: MuxRef }> = [];
  for (const kind of kinds) {
    const ref = await probe.resolveRefInMux(server, kind, target);
    if (ref) found.push({ kind, ref });
  }
  if (found.length > 1) throw new AmbiguousWindowKindError(target, found.map((f) => f.kind));
  return found[0] ?? null;
}
