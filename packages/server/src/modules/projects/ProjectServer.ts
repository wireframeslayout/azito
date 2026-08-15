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
   * 'allow' would skip approval entirely but is not selectable via the API
   * yet — an isolated execution profile for it doesn't exist (see
   * routes.ts). Has no effect on trusted-origin tasks.
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
