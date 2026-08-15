export type MuxRuntime = 'system' | 'managed';

/**
 * The `isolation_report` value `updateIsolationIntent` atomically writes on a
 * false->true transition, BEFORE any cleanup attempt actually runs (Issue
 * #29 review, final pass, Important finding 2). Exported so both the
 * repository (write) and the startup recovery pass / route retry logic
 * (read) parse/compare against the exact same literal — see
 * `IServerRepository.updateIsolationIntent`'s doc comment for why this must
 * be written atomically with the intent flip rather than left NULL.
 */
export const ISOLATION_CLEANUP_PENDING_REPORT = JSON.stringify({ kind: 'cleanup', cleanup: 'pending' });

export interface ServerConfig {
  name: string;
  type: 'local' | 'agent';
  host: string | null;
  agentPort: number | null;
  agentToken: string | null;
  agentVersion: string | null;
  sshHost: string | null;
  muxRuntime: MuxRuntime;
  sshHostFingerprint: string | null;
  /**
   * Declared isolation intent (Issue #29 design v2 "隔離実行プロファイル",
   *層1「宣言」): true means this server is meant to hold no credentials.
   * Not itself a verified fact — the isolation doctor (層2「検証」, a later
   * task) checks that separately and records the result in
   * `isolationVerifiedAt`/`isolationReport`. Deliberately used for
   * credential-distribution decisions on its own (層3「遮断」 — see
   * TaskPaneEnvironmentService.buildEnvForNewWindow and HarnessInstaller):
   * the hub fails closed on intent alone rather than waiting for a doctor
   * run, so declaring intent takes effect immediately. Only settable for
   * `type: 'agent'` servers (PUT /api/servers/:name rejects it for `local`
   * — a local server always shares the hub's own credential store).
   */
  isolationIntent: boolean;
  /**
   * ISO timestamp of the isolation doctor's last check, or null if it has
   * never run. Issue #29 review, Important finding 3: cleared atomically
   * (same UPDATE) whenever isolationIntent changes — see
   * `updateIsolationIntent`'s doc comment. A stale verifiedAt/report pair
   * from before the transition must never be readable as describing the
   * server's current declared state.
   */
  isolationVerifiedAt: string | null;
  /**
   * JSON blob of the isolation DOCTOR's last verification result
   * (`kind: 'verification'`), or null. Detail-only — not returned by the
   * servers-list API, only by the per-server detail route.
   *
   * Review round (isolation doctor review, Important finding 4): before this
   * split, this single column was shared by two independent writers —
   * `attemptIsolationCleanup` (routes.ts, `kind: 'cleanup'`) and
   * `runIsolationDoctor`'s persistence (`kind: 'verification'`) — so
   * whichever ran LAST clobbered the other's outcome, and
   * `isolationCleanupNeedsRetry` (which needs to read the cleanup outcome
   * specifically) could be defeated by a doctor run overwriting a settled
   * `'done'` cleanup report. This column is now VERIFICATION-ONLY; the
   * cleanup outcome lives in the separate `isolationCleanupReport` field
   * below. Cleared together with `isolationVerifiedAt` on every
   * isolation_intent change (see `updateIsolationIntent`).
   */
  isolationReport: string | null;
  /**
   * JSON blob of the last synchronous remote-token-purge (`kind: 'cleanup'`)
   * outcome PUT /api/servers/:name's false->true transition records
   * (`attemptIsolationCleanup` in routes.ts), or the
   * `ISOLATION_CLEANUP_PENDING_REPORT` placeholder written atomically with
   * that same transition before the purge attempt has run — or null. This
   * is the field `isolationCleanupNeedsRetry` (routes.ts) reads to decide
   * whether a true->true PUT should re-enter cleanup; it is never touched by
   * the isolation doctor (see `isolationReport`'s doc comment above for why
   * the two are split). Cleared together with `isolationReport`/
   * `isolationVerifiedAt` on every isolation_intent change.
   */
  isolationCleanupReport: string | null;
  createdAt: string;
}

export interface IServerRepository {
  findAll(): ServerConfig[];
  findByName(name: string): ServerConfig | null;
  create(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, agentVersion?: string, sshHost?: string, muxRuntime?: MuxRuntime): void;
  update(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, sshHost?: string, muxRuntime?: MuxRuntime): void;
  /**
   * Issue #29 review, Important finding 1: atomically combines `update()`
   * (connection info) and the isolation-intent auto-clear (`isolationIntent
   * false`, `isolationVerifiedAt`/`isolationReport` cleared to NULL — same
   * semantics as `updateIsolationIntent(name, false)`) in a single SQLite
   * transaction. Used by PUT /api/servers/:name when the server's effective
   * type is no longer 'agent' and it was previously isolated — a crash
   * between two separate statements must never leave an isolated row with a
   * non-agent type. Optional: implemented by `SqliteServerRepository`;
   * existing `IServerRepository` mocks predate this method and are not
   * required to stub it (routes.ts calls it via `?.()` with a same-effect
   * two-call fallback for callers that only implement `update` +
   * `updateIsolationIntent`).
   */
  updateWithIsolationClear?(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, sshHost?: string, muxRuntime?: MuxRuntime): void;
  updateAgentVersion(name: string, version: string): void;
  updateFingerprint(name: string, fingerprint: string): void;
  clearFingerprint(name: string): void;
  /**
   * Issue #29 review, Important finding 3: also clears
   * `isolation_verified_at`/`isolation_report` to NULL in the same
   * statement as the intent flip (see `SqliteServerRepository`'s
   * implementation comment) — callers must not assume a separate clear step
   * is needed or possible to skip.
   *
   * Issue #29 review (final pass), Important finding 2: a false->true
   * transition initializes `isolation_cleanup_report` to
   * `{"kind":"cleanup","cleanup":"pending"}` ATOMICALLY in this same
   * statement, not to NULL — a process crash between this commit and
   * `attemptIsolationCleanup`'s own `updateIsolationCleanupReport()` write
   * previously left `isolation_intent=1` with the cleanup report NULL, a
   * state indistinguishable from "declared isolated, cleanup not yet
   * attempted OR quietly skipped" that routes.ts's own true->true no-op
   * guard then preserved forever (nothing ever retried it). A false->true
   * transition (`isolationIntent: true`) writes the pending marker; a
   * true->false transition (`isolationIntent: false`) still clears to NULL
   * as before — only the true direction needs a placeholder, since only
   * that direction has a cleanup attempt to track. `isolation_report`
   * (verification, the OTHER column — see review round, Important finding
   * 4 / Server.ts's doc comments) is unconditionally cleared to NULL on
   * every intent change, same as `isolation_verified_at` — a stale
   * pre-transition doctor result must never survive an intent flip either.
   */
  updateIsolationIntent(name: string, isolationIntent: boolean): void;
  /**
   * Persists a JSON blob to `isolation_report` (the DOCTOR's verification
   * column — see Server.ts's `isolationReport` doc comment), or clears it
   * with `null`. Issue #29 Step 2 B: used as the doctor's fallback writer
   * for a failing/unverifiable run (report only, `isolationVerifiedAt` left
   * untouched — see `updateIsolationVerification` below for the passing-run
   * case). Review round (Important finding 4): this method no longer writes
   * the cleanup outcome — that moved to `updateIsolationCleanupReport`
   * below, its own separate column. Optional: implemented by
   * `SqliteServerRepository`; the many existing `IServerRepository` mocks
   * across the test suite predate this method and are not required to stub
   * it (routes.ts calls it via `?.()`).
   */
  updateIsolationReport?(name: string, report: string | null): void;
  /**
   * Persists a JSON blob to `isolation_cleanup_report` (the CLEANUP-only
   * column split out of the doctor's verification column — see Server.ts's
   * `isolationCleanupReport` doc comment and the review round's Important
   * finding 4), or clears it with `null`. Used by the false->true
   * isolation_intent transition in servers routes to record the *outcome*
   * of the synchronous remote-cleanup attempt it triggers
   * (`{"kind":"cleanup","cleanup":"done"|"failed"|"skipped",...}`), and by
   * the true->true retry path / startup interruption recovery that read the
   * same outcome back via `isolationCleanupNeedsRetry`. Optional, matching
   * every other isolation writer on this interface: implemented by
   * `SqliteServerRepository`; existing `IServerRepository` mocks predate
   * this method.
   */
  updateIsolationCleanupReport?(name: string, report: string | null): void;
  /**
   * Issue #29 Step 2 B: the isolation doctor's own writer, distinct from
   * `updateIsolationReport` above — a PASSING doctor run (every check
   * `pass`) must update `isolation_verified_at` in the SAME statement as
   * `isolation_report` (`{"kind":"verification","verified":true,...}`), not
   * as a separate call, so no reader can observe a `verified:true` report
   * next to a stale/absent `isolationVerifiedAt`. A failing/unverifiable
   * doctor run does NOT call this — it calls `updateIsolationReport` alone
   * (report only, `isolationVerifiedAt` left untouched) per the doctor's own
   * fail-closed contract: only a fully-passing run may ever advance
   * `isolationVerifiedAt`. Optional for the same reason the other isolation
   * writers on this interface are: implemented by `SqliteServerRepository`;
   * existing `IServerRepository` mocks predate this method.
   */
  updateIsolationVerification?(name: string, report: string, verifiedAt: string): void;
  delete(name: string): void;
}
