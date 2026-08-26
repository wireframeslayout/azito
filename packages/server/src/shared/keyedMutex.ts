/**
 * Generic in-process mutex keyed by an arbitrary string, implemented as a
 * Promise chain per key (same pattern as
 * `FileBrowseService`'s per-(serverName, path) `writeLocks`/`withWriteLock`
 * — see that class's doc comment for the "single hub process, Promise
 * chaining is sufficient" rationale). Extracted here so other modules that
 * need the same "serialize everything touching key K" guarantee (e.g. the
 * isolation_intent false->true transition vs. session/window/pane creation
 * on the same server name — Issue #29 review, 6th pass, Important finding 3)
 * can share one implementation instead of re-deriving it.
 *
 * Entries are removed once their chain settles so the map does not grow
 * unbounded.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    // Swallow the prior run's rejection here (not propagated) so one failed
    // run doesn't poison the chain for the next caller waiting on the same
    // key — each caller still observes its own fn()'s outcome via the
    // returned/awaited `run` below.
    const run = prior.catch(() => {}).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) {
        this.locks.delete(key);
      }
    }
  }
}
