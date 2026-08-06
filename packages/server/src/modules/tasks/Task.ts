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
   * Hash of the task.description that a human most recently approved for
   * unattended execution while input_trust = 'untrusted'. Null means "never
   * approved" or "approved description is stale" (description changed
   * since). See ExecutionGate.checkExecutionGate for the comparison.
   */
  executionApprovedDescriptionHash: string | null;
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
