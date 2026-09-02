// Pure helper logic for RepoDiscoveryDialog, split out so it can be unit
// tested directly (the component itself has no existing test coverage,
// matching the project's existing convention of testing the pure-logic
// side of a component rather than adding component tests from scratch —
// see e.g. browserTouchGesture.ts / browserWheelGesture.ts).

/**
 * Guards against a stale (out-of-order) async response overwriting state
 * from a later request.
 *
 * Issue #19 third-party review round 2, Important finding 2: discovery
 * requests were not sequenced or cancelled. Closing the dialog on server A
 * mid-scan and reopening it on server B could let A's slower response land
 * after B's and silently overwrite B's results — including allowing the
 * wrong server's repositories to be registered.
 *
 * `start()` is called synchronously right before issuing a request and
 * returns that request's id. Once the response comes back, `isCurrent(id)`
 * reports whether this is still the most recently started request; the
 * caller applies the response to state only when it is.
 */
export function createRequestGuard() {
  let latestId = 0;
  return {
    start(): number {
      latestId += 1;
      return latestId;
    },
    isCurrent(id: number): boolean {
      return id === latestId;
    },
  };
}

export interface SelectableRemote {
  url: string;
  alreadyRegistered: boolean;
}

/**
 * Issue #19 third-party review round 2, Minor finding 4: "select all" used
 * `selectableRemotes.length`, which counts raw (possibly duplicate-URL)
 * remote occurrences — multiple clones/worktrees commonly share the same
 * remote URL. Selection itself is keyed by URL (a `Set<string>`), so the
 * comparison must use the same deduplicated key space, or "select all"
 * never reads as checked and toggling one occurrence flips every other
 * occurrence of that URL at once.
 */
export function dedupeSelectableUrls(remotes: SelectableRemote[]): string[] {
  const seen = new Set<string>();
  for (const remote of remotes) {
    if (!remote.alreadyRegistered) seen.add(remote.url);
  }
  return [...seen];
}
