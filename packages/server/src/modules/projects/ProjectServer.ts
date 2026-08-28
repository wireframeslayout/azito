export interface ProjectServer {
  projectId: number;
  serverName: string;
  workingDirectory: string | null;
  branch: string | null;
  /** tmux session used to run tasks for this project on this server. NOT NULL, defaults to 'azito'. */
  tmuxSession: string;
  /**
   * Execution policy for untrusted-origin tasks (Issue #328) on this
   * project+server pairing. 'deny' rejects execution outright; 'manual-approval'
   * requires a human approval before the first worker/worktree/secret touch;
   * 'allow' skips approval entirely, but only ever takes effect for a
   * verified-isolated server — see `resolveEffectiveInputPolicy` below (Issue
   * #29 Step 3a). Has no effect on trusted-origin tasks.
   */
  inputPolicy: 'deny' | 'manual-approval' | 'allow';
  /**
   * Whether the hub should distribute this project's code to this server on
   * the hub's own git credentials (Issue #87 Phase 2 — generalizes the
   * isolated-server-only distribution path in ExecuteTaskUseCase to any
   * agent/ssh server). An isolated server has no git credentials of its own,
   * so distribution is mandatory there regardless of this flag; a normal
   * agent/ssh server can opt into the same mechanism for instant dev
   * environment provisioning without ever holding hub-side credentials.
   * Meaningless for a `local` server (that IS the hub) — ExecuteTaskUseCase
   * excludes `local` from the gate outright. Defaults off.
   */
  distributeCode: boolean;
}

/** Full row for upsert — tmuxSession is required; callers resolve it at the boundary. */
export type UpsertProjectServerInput = ProjectServer;

export interface IProjectServerRepository {
  findByProject(projectId: number): ProjectServer[];
  findByServer(serverName: string): ProjectServer[];
  find(projectId: number, serverName: string): ProjectServer | null;
  upsert(data: UpsertProjectServerInput): void;
  remove(projectId: number, serverName: string): void;
}

/** Default applied when no project_servers row exists for a (project, server) pairing yet, or the row leaves the field unset. */
const DEFAULT_INPUT_POLICY: ProjectServer['inputPolicy'] = 'manual-approval';

/**
 * Single source of truth for "what input policy is effectively in force" for
 * a (project, server) pairing (Issue #29 Step 0 — previously this fallback
 * was applied separately in ExecutionGate.checkExecutionGate() and in the
 * PUT /api/projects/:id/servers/:serverName handler, with the default
 * literal duplicated in both places).
 *
 * Lives in the `projects` module, not `tasks/execution` (where the other
 * task-side `resolve*` helpers live, e.g. TaskExecutionEnv.ts) because this
 * function needs to be callable from BOTH sides: every `tasks`/`windows`
 * call site that resolves a project_servers row before calling
 * `checkExecutionGate` (tasks already legitimately imports from `projects` —
 * see ExecutionGate.ts/TaskExecutionEnv.ts), and `projects/routes.ts`'s own
 * PUT handler, which cannot import from `tasks` (no reverse edge exists at
 * this upper layer). Placing it here keeps the dependency direction
 * one-way in both directions that need it.
 *
 * Deliberately takes an already-resolved row (or null), not a repository —
 * `checkExecutionGate` itself stays a pure comparator with no repository
 * access (Issue #328 design constraint, restated for Issue #29): every
 * caller resolves the projectServer row at its own boundary first, then
 * calls this function, then passes the result into `checkExecutionGate`.
 */
export function resolveInputPolicy(
  projectServer: Pick<ProjectServer, 'inputPolicy'> | null | undefined,
): ProjectServer['inputPolicy'] {
  return projectServer?.inputPolicy ?? DEFAULT_INPUT_POLICY;
}

/**
 * TTL for an isolation doctor verification to still count as current (Issue
 * #29 Step 3a). Must stay equal to the frontend's own copy
 * (`ISOLATION_VERIFICATION_TTL_MS` in
 * `packages/frontend/src/components/servers/sections/OverviewSection.tsx`) —
 * the two render the SAME fact (whether a server's `isolationVerifiedAt` is
 * still current) for two different audiences (this one gates unattended
 * execution server-side; the frontend one only decides a badge's color), and
 * a drift between them would let the UI show "verified" for a server whose
 * `allow` policy the backend has already silently downgraded, or the reverse.
 * No shared module carries both today (frontend cannot import server code);
 * kept in sync by this cross-reference until one exists.
 */
export const ISOLATION_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Tolerance for `isolationVerifiedAt` reading slightly ahead of `now` (Issue
 * #29 Step 3a review round, Important finding 3): ordinary clock drift
 * between the process that wrote the doctor verification and the process
 * reading it back (e.g. NTP correction mid-request) can put a genuinely
 * fresh timestamp a few seconds/minutes in the future. 5 minutes comfortably
 * covers that without opening a meaningful window for abuse — a
 * `verifiedAtMs` any further ahead of `now` than this is not clock drift,
 * it's either a rolled-back system clock or a corrupted/forged write, and
 * `now - verifiedAtMs` would otherwise be negative and satisfy the TTL
 * comparison below forever (Issue #29 Step 3a review round finding 3: an
 * `'allow'` policy staying effective indefinitely because its verification
 * timestamp never "expires" is a fail-open bug, not a display glitch).
 */
const ISOLATION_VERIFICATION_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Why `resolveEffectiveInputPolicy` downgraded a requested `'allow'` to `'manual-approval'`. `null` when no downgrade occurred (the requested policy was returned as-is). */
export type AllowDegradedReason = 'not_isolated' | 'verification_missing' | 'verification_expired' | 'scoped_auth_disabled' | 'verification_failed';

export interface EffectiveInputPolicy {
  /** The policy `resolveInputPolicy` resolved from the project_servers row — what the operator asked for. */
  requestedPolicy: ProjectServer['inputPolicy'];
  /** The policy `checkExecutionGate` must actually be called with. Equal to `requestedPolicy` unless it was `'allow'` and got downgraded. */
  effectivePolicy: ProjectServer['inputPolicy'];
  allowDegradedReason: AllowDegradedReason | null;
}

/**
 * Server-side 3-point AND gate for the `'allow'` input policy (Issue #29
 * Step 3a, approved design v2): a requested `'allow'` is only ever effective
 * when (a) the target server has declared isolation intent, (b) that intent
 * was verified by the isolation doctor within {@link ISOLATION_VERIFICATION_TTL_MS},
 * AND (c) scoped auth is enabled for this hub process right now. Any one
 * missing degrades to `'manual-approval'` — never to an error, and never
 * silently to `'deny'` — with a specific reason so callers can log/surface
 * why. `'deny'`/`'manual-approval'` requests pass through unchanged; only
 * `'allow'` is ever subject to this re-check, since it is the only policy
 * whose safety depends on live, time-bounded facts about the server rather
 * than the operator's own static configuration.
 *
 * Deliberately takes an already-resolved `server` (or null), not a
 * repository — same "resolve at the boundary, stay a pure comparator"
 * discipline `checkExecutionGate` itself follows (see ExecutionGate.ts's
 * doc comment): every call site resolves the target `ServerConfig` (or the
 * manifest's `serverConfig`) before calling in here, then passes the
 * resolved {@link EffectiveInputPolicy.effectivePolicy} into
 * `checkExecutionGate`, never the raw `resolveInputPolicy` result, whenever
 * `task.inputTrust === 'untrusted'`.
 *
 * `now` is only ever overridden by tests.
 */
export function resolveEffectiveInputPolicy(
  projectServer: Pick<ProjectServer, 'inputPolicy'> | null | undefined,
  server: { isolationIntent: boolean; isolationVerifiedAt: string | null; isolationReport: string | null } | null | undefined,
  scopedAuthEnabled: boolean,
  now: number = Date.now(),
): EffectiveInputPolicy {
  const requestedPolicy = resolveInputPolicy(projectServer);
  if (requestedPolicy !== 'allow') {
    return { requestedPolicy, effectivePolicy: requestedPolicy, allowDegradedReason: null };
  }
  const degrade = (allowDegradedReason: AllowDegradedReason): EffectiveInputPolicy =>
    ({ requestedPolicy, effectivePolicy: 'manual-approval', allowDegradedReason });

  if (!server?.isolationIntent) return degrade('not_isolated');
  // `isolationVerifiedAt` is written ONLY by a FULLY PASSING isolation
  // doctor run (`SqliteServerRepository.updateIsolationVerification`), and
  // cleared to NULL atomically by every OTHER writer of `isolation_report`
  // (`updateIsolationFailure` for a failing/unverifiable doctor run,
  // `updateIsolationIntent` for an intent flip — see Server.ts's
  // `isolationVerifiedAt` doc comment and Issue #29 review Step 3a Critical
  // finding 1). A non-null, non-stale value should therefore already imply a
  // genuine `verified: true` report by construction.
  if (!server.isolationVerifiedAt) return degrade('verification_missing');
  const verifiedAtMs = new Date(server.isolationVerifiedAt).getTime();
  // A timestamp meaningfully in the future (beyond ordinary clock skew) must
  // fail closed the same way an actually-stale one does — `now - verifiedAtMs`
  // going negative would otherwise satisfy the TTL check below forever (Issue
  // #29 Step 3a review round, Important finding 3). Reported as the same
  // 'verification_expired' reason: this is a variant of "the verification
  // this process can trust has lapsed", not a new user-facing category, and
  // reusing it avoids adding a reason value the frontend's i18n tables
  // (tasks.json en/ja) and duplicated AllowDegradedReason union would both
  // need updating for.
  if (!Number.isFinite(verifiedAtMs) || verifiedAtMs > now + ISOLATION_VERIFICATION_CLOCK_SKEW_TOLERANCE_MS || now - verifiedAtMs > ISOLATION_VERIFICATION_TTL_MS) {
    return degrade('verification_expired');
  }
  if (!scopedAuthEnabled) return degrade('scoped_auth_disabled');
  // Defense in depth (Issue #29 review Step 3a Critical finding 1 follow-up):
  // do not trust a non-null, non-stale `isolationVerifiedAt` blindly — parse
  // the report it should be paired with and confirm it actually says
  // `verified: true`. This is deliberately redundant with the invariant the
  // comment above describes; it exists only so a future writer that
  // violates that invariant (updates `isolationVerifiedAt` without also
  // writing a passing `isolationReport`, or vice versa) fails closed here
  // instead of silently granting unattended execution.
  if (!isPassingVerificationReport(server.isolationReport)) return degrade('verification_failed');
  return { requestedPolicy, effectivePolicy: 'allow', allowDegradedReason: null };
}

/** Parses `isolationReport` and confirms it is a passing (`kind: 'verification', verified: true`) doctor report — see `resolveEffectiveInputPolicy`'s defense-in-depth check above. Malformed/missing/non-passing JSON is treated as "not a passing report" (fail closed), never as an error to propagate. */
function isPassingVerificationReport(report: string | null): boolean {
  if (!report) return false;
  try {
    const parsed = JSON.parse(report) as { kind?: unknown; verified?: unknown };
    return parsed.kind === 'verification' && parsed.verified === true;
  } catch {
    return false;
  }
}
