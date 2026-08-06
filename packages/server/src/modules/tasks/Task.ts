import { TaskStatus } from './TaskStatus';
import type { SubagentConfig } from '../units/Unit';

export interface Task {
  id: number;
  projectId: number;
  /** Unit override for this task; falls back to project.defaultUnitId when null. */
  unitId: number | null;
  /** Execution server override for this task; falls back to the project's first project_servers row when null. */
  serverName: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  currentPhase: string | null;
  selfReviewCount: number;
  priority: number;
  tmuxWindow: string | null;
  selfReviewMaxAttempts: number | null;
  requirePlanApproval: boolean;
  source: 'local' | 'github' | 'gitlab';
  sourceRef: string | null;
  /**
   * Immutable-by-client trust level (Issue #328). Unlike `source`, this is
   * never accepted from POST/PUT /api/tasks request bodies — it is the only
   * signal the execution gate (modules/tasks/execution/ExecutionGate.ts)
   * relies on to tell external-origin tasks apart, precisely because
   * `source` is freely rewritable by /azt-link and thus cannot be trusted
   * for authorization. Only server-side code paths (import-issue) may set
   * 'untrusted'; nothing may transition 'untrusted' back to 'trusted'.
   */
  inputTrust: 'trusted' | 'untrusted';
  /**
   * Fingerprint (see ExecutionManifest.hashExecutionManifest) of the
   * RESOLVED execution manifest — not raw task columns — that a human most
   * recently approved for unattended execution while input_trust =
   * 'untrusted': the resolved Unit's content, the resolved server's
   * project_servers config, resolved base/target/work branches, task
   * title/description, and resolved subagent config (see
   * ExecutionManifest.ts's module doc comment for the authoritative list and
   * inclusion criteria — it covers more than this row alone, e.g.
   * project.defaultUnitId and the resolved Unit's systemPrompt). Null means
   * "never approved" or "the resolved manifest is stale" (something it
   * covers changed since, on the task OR elsewhere it resolves through). See
   * ExecutionGate.checkExecutionGate for the comparison.
   */
  executionApprovedFingerprintHash: string | null;
  /**
   * Which operation the execution gate blocked and must be resumed (not
   * re-inferred) once a human approves (Issue #328 third/fourth-round
   * review): see modules/units/routes.ts's approve-execution handler. Set
   * immediately before the gate throws and cleared once approval consumes
   * it. NULL means "no pending operation" — the normal state, and also the
   * fallback the approval handler uses for any row that predates this
   * column (see migration 059's comment; there is no such row in practice,
   * 059 has never shipped).
   *
   * Write-site catalogue (every gate that can set this MUST be listed here
   * — a value added without a matching writer is exactly how the fourth-
   * round review's "forgotten wiring" bug happened, silently falling back
   * to the wrong resumed operation):
   * - 'execute'  — ExecuteTaskUseCase.enforceExecutionGate (execute() entry)
   * - 'resume'   — ExecuteTaskUseCase.enforceExecutionGate (followUp()/
   *                resumeStateMachine() entries)
   * - 'restore'  — TaskRestoreService.restore
   * - 'respawn'  — WindowRespawnService.enforceExecutionGate (respawn()
   *                entry); pendingOperationWindowId is set alongside this
   *                value and MUST be used to resume it (see below)
   * - 'recover_session_legacy' — WindowRespawnService.enforceExecutionGate
   *                (resumeLegacySession() entry, the pre-migration-034
   *                window-less fallback used by POST /api/tasks/:id/
   *                recover-session)
   */
  pendingOperation: 'execute' | 'resume' | 'restore' | 'respawn' | 'recover_session_legacy' | null;
  /**
   * The Window row id to resume when pendingOperation === 'respawn' — a
   * respawn-blocked task has no other reliable way to recover which window
   * was being respawned (unlike 'execute'/'resume'/'restore', which
   * re-resolve their target entirely from task/project fields).
   * NULL for every other pendingOperation value. Set by
   * WindowRespawnService.enforceExecutionGate alongside pendingOperation and
   * cleared whenever pendingOperation is cleared.
   */
  pendingOperationWindowId: number | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  skipPr: boolean;
  workingDirectory: string | null;
  branch: string | null;
  planMarkdown: string | null;
  pendingQuestions: string | null;
  changedFiles: string | null;
  summaryJson: string | null;
  prUrl: string | null;
  agentSessionId: string | null;
  reviewSubagent?: SubagentConfig | null;
  implementSubagent?: SubagentConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface ITaskRepository {
  findAll(): Task[];
  findByProject(projectId: number): Task[];
  findByUnit(unitId: number): Task[];
  findByStatus(status: TaskStatus): Task[];
  findAgentSessionIdsByServer(serverName: string): Set<string>;
  findById(id: number): Task | null;
  create(data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): number;
  update(id: number, data: Partial<Task>): void;
  updateStatus(id: number, status: TaskStatus): void;
  updateCurrentPhase(id: number, phase: string | null): void;
  touch(id: number): void;
  delete(id: number): void;
}
