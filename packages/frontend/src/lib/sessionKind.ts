import { parseMuxRef, type MuxDriverKind } from '@azito/shared';

/** What these helpers read of a listed session (both session shapes the frontend keeps satisfy it). */
interface KindedSession { name: string; kind?: MuxDriverKind; windows?: ReadonlyArray<{ ref: string }> }

/**
 * A server can list tmux and misao sessions side by side, and the two can share a name: everything that matches or
 * acts on a session has to tell them apart by the session's `kind`, not by the server's default mux.
 */

/**
 * The mux a listed session lives in: the hub's stamp. A session listed without one (a hub before the stamp) is
 * told by its windows' refs, which always carry their kind; an empty unstamped session is a tmux one.
 */
export function sessionKindOf(session: Pick<KindedSession, 'kind' | 'windows'>): MuxDriverKind {
  if (session.kind) return session.kind;
  for (const w of session.windows ?? []) {
    const kind = refKindOf(w.ref);
    if (kind) return kind;
  }
  return 'tmux';
}

/** The mux a window ref names, or undefined when the ref cannot be parsed. */
export function refKindOf(ref: string | null | undefined): MuxDriverKind | undefined {
  if (!ref) return undefined;
  try {
    return parseMuxRef(ref).kind;
  } catch {
    return undefined;
  }
}

/** Whether a call about a session or window of `kind` goes through the mux routes (anything but tmux) or the legacy tmux routes. */
export function usesMuxRoutes(kind: MuxDriverKind): boolean {
  return kind !== 'tmux';
}

/** Whether a call about the window `ref` names goes through the mux routes (a ref of a mux other than tmux). */
export function refUsesMuxRoutes(ref: string | null | undefined): ref is string {
  const kind = refKindOf(ref);
  return kind !== undefined && usesMuxRoutes(kind);
}

/**
 * A stable select value for a session. tmux keeps the plain name (tmux names never contain ':'), so a tmux-only
 * server's values are unchanged; a session of another mux is prefixed with its kind.
 */
export function sessionKey(session: KindedSession): string {
  const kind = sessionKindOf(session);
  return kind === 'tmux' ? session.name : `${kind}:${session.name}`;
}

export function findSessionByKey<S extends KindedSession>(sessions: readonly S[], key: string): S | undefined {
  return sessions.find((s) => sessionKey(s) === key);
}

/** Whether `sessions` hold more than one mux (labels then name the mux, so same-named sessions can be told apart). */
export function hasMixedKinds(sessions: readonly Pick<KindedSession, 'kind' | 'windows'>[]): boolean {
  return new Set(sessions.map(sessionKindOf)).size > 1;
}

export interface WindowTargetOption<W> {
  /** `<session>:<index>` for a tmux window (unchanged); `<workspace>:<window id>` for a misao window. */
  value: string;
  kind: MuxDriverKind;
  /** The ref the server reported for the window. */
  ref: string;
  session: string;
  window: W;
}

/**
 * The windows a picker offers. A misao window is offered by its id: an ordinal shifts when a window closes and would
 * then name another window (or a tmux window of the same name and index).
 */
export function windowTargetOptions<W extends { index: number; ref: string }>(
  sessions: readonly (KindedSession & { windows: W[] })[],
): WindowTargetOption<W>[] {
  const options: WindowTargetOption<W>[] = [];
  for (const s of sessions) {
    const kind = sessionKindOf(s);
    for (const w of s.windows) {
      const id = kind === 'misao' ? parseMuxRef(w.ref) : null;
      options.push({
        value: id ? `${id.workspace}:${id.window}` : `${s.name}:${w.index}`,
        kind,
        ref: w.ref,
        session: s.name,
        window: w,
      });
    }
  }
  return options;
}

/**
 * The add-window picker's options: `windowTargetOptions` with a label. When the server lists two muxes the label
 * names the mux, so same-named sessions (and their windows of the same index) can be told apart.
 */
export function windowTargetSelectOptions<W extends { index: number; ref: string; name: string; panes: unknown[] }>(
  sessions: readonly (KindedSession & { windows: W[] })[],
): Array<WindowTargetOption<W> & { label: string }> {
  const mixed = hasMixedKinds(sessions);
  return windowTargetOptions(sessions).map((o) => ({
    ...o,
    label: `${o.session}${mixed ? ` (${o.kind})` : ''} / ${o.window.index}: ${o.window.name} (${o.window.panes.length} panes)`,
  }));
}

/** A session option's label: the name, plus the mux when the server lists two. */
export function sessionOptionLabel(session: KindedSession, mixed: boolean): string {
  return mixed ? `${session.name} (${sessionKindOf(session)})` : session.name;
}
