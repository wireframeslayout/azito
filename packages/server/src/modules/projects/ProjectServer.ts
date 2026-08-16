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

/** Why `resolveEffectiveInputPolicy` downgraded a requested `'allow'` to `'manual-approval'`. `null` when no downgrade occurred (the requested policy was returned as-is). */
export type AllowDegradedReason = 'not_isolated' | 'verification_missing' | 'verification_expired' | 'scoped_auth_disabled';

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
  server: { isolationIntent: boolean; isolationVerifiedAt: string | null } | null | undefined,
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
  // `isolationVerifiedAt` is only ever written by a FULLY PASSING isolation
  // doctor run (see Server.ts's `updateIsolationVerification` doc comment) —
  // a non-null, non-stale value already implies a genuine `verified: true`
  // report, so there is no separate isolationReport check needed here.
  if (!server.isolationVerifiedAt) return degrade('verification_missing');
  const verifiedAtMs = new Date(server.isolationVerifiedAt).getTime();
  if (!Number.isFinite(verifiedAtMs) || now - verifiedAtMs > ISOLATION_VERIFICATION_TTL_MS) return degrade('verification_expired');
  if (!scopedAuthEnabled) return degrade('scoped_auth_disabled');
  return { requestedPolicy, effectivePolicy: 'allow', allowDegradedReason: null };
}
