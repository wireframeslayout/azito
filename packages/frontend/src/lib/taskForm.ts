import type { SubagentConfig } from '../components/ui';

export interface TaskFormValue {
  projectId: string;
  title: string;
  description: string;
  serverName: string;
  workingDirectory: string;
  unitId: string;
  priority: string;         // '0'|'1'|'2'
  tmuxWindow: string;
  status: string;           // edit のみ使用
  selfReviewMax: string;    // '' | '0'..'3'
  requirePlanApproval: boolean;
  baseBranch: string;
  targetBranch: string;
  skipPr: boolean;
  workingBranch: string;
  overrideSubagents: boolean;
  reviewSubagent: SubagentConfig | null;
  implementSubagent: SubagentConfig | null;
  source: { source: string; sourceRef?: string } | null;
}

export function emptyTaskForm(overrides?: Partial<TaskFormValue>): TaskFormValue {
  return {
    projectId: '',
    title: '',
    description: '',
    serverName: '',
    workingDirectory: '',
    unitId: '',
    priority: '0',
    tmuxWindow: '',
    status: 'open',
    selfReviewMax: '',
    requirePlanApproval: true,
    baseBranch: '',
    targetBranch: '',
    skipPr: false,
    workingBranch: '',
    overrideSubagents: false,
    reviewSubagent: null,
    implementSubagent: null,
    source: null,
    ...overrides,
  };
}

function buildSubagentPayload(v: TaskFormValue): Record<string, unknown> {
  if (!v.overrideSubagents) return {};
  return {
    review_subagent: v.reviewSubagent?.enabled
      ? { enabled: true, provider: v.reviewSubagent.provider, model: v.reviewSubagent.model }
      : null,
    implement_subagent: v.implementSubagent?.enabled
      ? { enabled: true, provider: v.implementSubagent.provider, model: v.implementSubagent.model }
      : null,
  };
}

export function buildTaskPayload(v: TaskFormValue, mode: 'create' | 'edit'): Record<string, unknown> {
  if (mode === 'edit') {
    return {
      title: v.title.trim(),
      description: v.description.trim(),
      status: v.status,
      unit_id: v.unitId ? parseInt(v.unitId, 10) : null,
      server_name: v.serverName.trim() || null,
      priority: parseInt(v.priority, 10),
      tmux_window: v.tmuxWindow.trim() || null,
      base_branch: v.baseBranch.trim() || null,
      target_branch: v.skipPr ? null : (v.targetBranch.trim() || null),
      skip_pr: v.skipPr,
      working_directory: v.workingDirectory.trim() || null,
      branch: v.skipPr ? (v.workingBranch.trim() || null) : null,
      ...buildSubagentPayload(v),
    };
  }

  // create
  const base: Record<string, unknown> = {
    project_id: parseInt(v.projectId, 10),
    title: v.title.trim(),
    description: v.description.trim(),
    unit_id: v.unitId ? parseInt(v.unitId, 10) : null,
    server_name: v.serverName.trim() || null,
    priority: parseInt(v.priority, 10),
    tmux_window: v.tmuxWindow.trim() || null,
    base_branch: v.baseBranch.trim() || null,
    target_branch: v.skipPr ? null : (v.targetBranch.trim() || null),
    skip_pr: v.skipPr,
    working_directory: v.workingDirectory.trim() || null,
    branch: v.skipPr ? (v.workingBranch.trim() || null) : null,
  };

  if (v.selfReviewMax) {
    base.self_review_max_attempts = parseInt(v.selfReviewMax, 10);
  }
  base.require_plan_approval = v.requirePlanApproval;

  // subagent override
  Object.assign(base, buildSubagentPayload(v));

  // source
  if (v.source) {
    base.source = v.source.source;
    if (v.source.sourceRef) base.source_ref = v.source.sourceRef;
  }

  return base;
}
