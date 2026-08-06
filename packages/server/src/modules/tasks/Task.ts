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
   * Fingerprint (see ExecutionGate.hashApprovedTaskFingerprint) of the
   * PUT-editable fields that determine WHAT runs and WHERE it runs (title,
   * description, unitId, serverName, branch, targetBranch, baseBranch,
   * workingDirectory — see ApprovableTaskFields in ExecutionGate.ts for the
   * authoritative list and inclusion criteria) that a human most recently
   * approved for unattended execution while input_trust = 'untrusted'. Null
   * means "never approved" or "approved fingerprint is stale" (one of those
   * fields changed since). See ExecutionGate.checkExecutionGate for the
   * comparison. Editing ANY covered field post-approval requires
   * re-approval — not just the ones that reach the worker's prompt as free
   * text, but also the ones that select which Unit/server/branch the
   * approval applies to.
   */
  executionApprovedFingerprintHash: string | null;
  /**
   * Which operation the execution gate blocked and must be resumed (not
   * re-inferred) once a human approves (Issue #328 third-round review): see
   * modules/units/routes.ts's approve-execution handler. Set immediately
   * before the gate throws (ExecuteTaskUseCase.enforceExecutionGate /
   * TaskRestoreService.restore) and cleared once approval consumes it. NULL
   * means "no pending operation" — the normal state, and also the fallback
   * the approval handler uses for any row that predates this column (see
   * migration 059's comment; there is no such row in practice, 059 has never
   * shipped).
   */
  pendingOperation: 'execute' | 'resume' | 'restore' | null;
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
