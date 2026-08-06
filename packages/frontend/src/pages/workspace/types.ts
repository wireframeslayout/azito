import type { PhaseConfigEntryLike } from '../../lib/taskPhases';

export type SidebarMode = 'windows' | 'tasks' | 'files' | 'repos' | 'storage' | 'settings';

export interface WindowPaneConfig {
  index: number;
  command?: string;
  workingDirectory?: string;
  title?: string;
  workerType?: string;
  agentSessionId?: string;
}

export interface WindowPaneLayout {
  layout: string;
  panes: WindowPaneConfig[];
}

export interface Window {
  id: number;
  ownerType: 'project' | 'task';
  projectId?: number;
  taskId?: number;
  serverName: string;
  tmuxTarget: string;
  label?: string;
  isPrimary: boolean;
  windowType: 'terminal' | 'agent';
  workerType?: string;
  workerModel?: string;
  agentSessionId?: string;
  launchCommand?: string;
  workingDirectory?: string;
  paneLayout?: WindowPaneLayout;
}
export interface Repository { id: number; url: string; name?: string; provider?: string; owner?: string; repoName?: string; }
export interface Project {
  id: number; name: string; slug: string; description?: string; workingDirectory?: string;
  defaultUnitId?: number | null;
  windows: Window[]; repositories: Repository[];
}
export interface ProjectServer {
  projectId: number; serverName: string; workingDirectory?: string | null; branch?: string | null;
  tmuxSession: string;
}
export type WorkerExecutionMode = 'tmux-pipe' | 'http-signal';
export type WorkerRuntime = 'tui' | 'headless' | 'api';
/**
 * Unit combines the former WorkerProfile (runtime: worker type/model/extra args,
 * execution mode) and Operation (behavior: system prompt, self-review, phase
 * config, subagents) into a single entity (Issue #263 Refine B/C).
 */
export interface UnitTypePhase {
  name: string;
  label: string;
  tags: string[];
}

export interface UnitType {
  name: string;
  label: string;
  description?: string;
  phases: UnitTypePhase[];
}

export interface Unit {
  id: number; name: string; unitType: string; systemPrompt?: string; selfReviewMaxAttempts?: number;
  reviewSubagent?: { enabled: boolean; provider: string; model: string } | null;
  implementSubagent?: { enabled: boolean; provider: string; model: string } | null;
  phaseConfig?: Record<string, PhaseConfigEntryLike> | null;
  workerType: string | null; workerModel: string | null; workerExtraArgs: string | null;
  workerExecutionMode: WorkerExecutionMode;
  workerRuntime: WorkerRuntime;
  workerCommand?: string | null;
  createdAt: string; updatedAt: string;
}
/** A currently-running execution of a Unit against a Task (formerly the Operation entity; Issue #263 Refine B). */
export interface RunningOperation {
  unitId: number; taskId: number; target: string; serverName: string;
}
export interface Task {
  id: number; title: string; description?: string; status: string; currentPhase?: string | null; projectId: number;
  unitId: number | null; serverName?: string | null;
  priority: number; tmuxWindow?: string;
  selfReviewMaxAttempts?: number;
  selfReviewCount?: number;
  requirePlanApproval?: boolean;
  planMarkdown?: string | null;
  pendingQuestions?: string | null;
  branch?: string;
  changedFiles?: string;
  summaryJson?: string | null;
  prUrl?: string;
  agentSessionId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseBranch?: string;
  targetBranch?: string;
  skipPr?: boolean;
  workingDirectory?: string | null;
  windows?: Window[];
  createdAt: string;
  updatedAt: string;
  reviewSubagent?: { enabled: boolean; provider: string; model: string } | null;
  implementSubagent?: { enabled: boolean; provider: string; model: string } | null;
  source?: 'local' | 'github' | 'gitlab';
  sourceRef?: string | null;
}
/** GET /api/tasks/:id/execution-approval response (Issue #51) — what a human
 * needs to see to approve/deny the untrusted-input execution gate. Mirrors
 * the server's ResolvedExecutionManifest reshaped for display; secret VALUES
 * are never included, only names. */
export interface ExecutionApprovalData {
  taskId: number;
  title: string;
  description: string | null;
  inputTrust: 'trusted' | 'untrusted';
  pendingOperation: string | null;
  inputPolicy: 'deny' | 'manual-approval' | 'allow' | null;
  execution: {
    unitId: number | null;
    unitName: string | null;
    serverName: string | null;
    workingDirectory: string | null;
    branches: { base: string; target: string; work: string };
    phases: Array<{ phase: string; sidekickName: string | null }>;
    repository: { id: number; provider: string; url: string; owner: string | null; repoName: string | null } | null;
  };
  secretNames: string[];
}

export interface Server { name: string; type: string; host?: string; }
export interface Pane { index: number; title: string; command: string; width: number; height: number; active: boolean; }
export interface TmuxWindow { index: number; name: string; panes: Pane[]; activity?: number; }
export interface Session { name: string; windows: TmuxWindow[]; }
export interface LogEntry { type: string; content: string; createdAt: string; unitId?: number; }

export const VALID_SIDEBAR_MODES: SidebarMode[] = ['windows', 'tasks', 'files', 'repos', 'storage', 'settings'];

// Data-driven project color picker presets — excluded from the token rule (ui-surface-policy.md).
export const PROJECT_COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', // lint-allow: hex
  '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff', // lint-allow: hex
  '#39d353', '#f0883e', '#db61a2', '#7ee787', '#a5d6ff', // lint-allow: hex
];

export function getProjectColorFallback(projectId: number): string {
  return PROJECT_COLORS[projectId % PROJECT_COLORS.length];
}

export const ACTIVE_PROJECT_KEY = 'workspace-active-project';
