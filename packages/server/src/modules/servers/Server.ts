export type MuxRuntime = 'system' | 'managed';

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
   * JSON blob of the isolation doctor's last check result, or null.
   * Detail-only — not returned by the servers-list API, only by the
   * per-server detail route. Issue #29 review, Important finding 3: the
   * JSON always carries a `kind: 'cleanup' | 'verification'` field so a
   * reader (frontend, future doctor implementation) can tell which of the
   * two distinct writers produced it — `'cleanup'` for the synchronous
   * remote-token-purge outcome PUT /api/servers/:name's false->true
   * transition records (`attemptIsolationCleanup` in routes.ts), reserving
   * `'verification'` for the isolation doctor (a later task) that this
   * field's own name describes. Cleared together with isolationVerifiedAt
   * on every isolation_intent change (see updateIsolationIntent).
   */
  isolationReport: string | null;
  createdAt: string;
}

export interface IServerRepository {
  findAll(): ServerConfig[];
  findByName(name: string): ServerConfig | null;
  create(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, agentVersion?: string, sshHost?: string, muxRuntime?: MuxRuntime): void;
  update(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, sshHost?: string, muxRuntime?: MuxRuntime): void;
  updateAgentVersion(name: string, version: string): void;
  updateFingerprint(name: string, fingerprint: string): void;
  clearFingerprint(name: string): void;
  /**
   * Issue #29 review, Important finding 3: also clears
   * `isolation_verified_at`/`isolation_report` to NULL in the same
   * statement as the intent flip (see `SqliteServerRepository`'s
   * implementation comment) — callers must not assume a separate clear step
   * is needed or possible to skip.
   */
  updateIsolationIntent(name: string, isolationIntent: boolean): void;
  /**
   * Persists a JSON blob to `isolation_report` (or clears it with `null`).
   * Issue #29 review, Important finding 1: used by the false->true
   * isolation_intent transition in servers routes to record the *outcome*
   * of the synchronous remote-cleanup attempt it triggers
   * (`{"kind":"cleanup","cleanup":"done"|"failed"|"skipped",...}`) — a
   * distinct, narrower use than the full isolation-doctor result this
   * field's own doc comment describes (that writer doesn't exist yet, and
   * will use `"kind":"verification"` to stay distinguishable — Issue #29
   * review, Important finding 3). Optional: implemented by
   * `SqliteServerRepository`; the many existing `IServerRepository` mocks
   * across the test suite predate this method and are not required to stub
   * it (routes.ts calls it via `?.()`).
   */
  updateIsolationReport?(name: string, report: string | null): void;
  delete(name: string): void;
}
