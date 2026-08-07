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

/**
 * @param original 編集モードで、サーバーから読み込んだ元の値。指定した場合、
 *   `status` は元の値から変更されているときのみ payload に含める
 *   （変更していないのに常に送ると、承認待ちタスクの編集が 409 で拒否されてしまう）。
 */
export function buildTaskPayload(v: TaskFormValue, mode: 'create' | 'edit', original?: TaskFormValue): Record<string, unknown> {
  if (mode === 'edit') {
    const payload: Record<string, unknown> = {
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
      ...buildSubagentPayload(v),
    };
    if (!original || v.status !== original.status) {
      payload.status = v.status;
    }
    return payload;
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

/**
 * Everything the untrusted-import creation banner (TaskFormView's
 * `UntrustedImportBanner`) actually renders to the human before they
 * approve — used both to build the banner's props and, after creation, as
 * one side of {@link compareExecutionApprovalContext}'s comparison against
 * the server's actually-resolved manifest.
 */
export interface DisplayedExecutionContext {
  title: string;
  description: string;
  serverName: string | null;
  workingDirectory: string | null;
  branches: { base: string; target: string; work: string };
  /** Ordered list of enabled phase names — see resolveEnabledPhaseNames() (lib/taskPhases.ts). */
  phases: string[];
  repository: { owner: string; repoName: string } | null;
  secretNames: string[];
}

/**
 * Create-form pre-approval fix (task/328-input-trust-and-exec-gate
 * follow-up, third-party review) — the banner shown BEFORE task creation is
 * necessarily a client-side approximation (no task row exists yet to
 * resolve project_servers defaults, phaseConfig, or the target repository
 * against). This compares that approximation against the response of GET
 * /api/tasks/:id/execution-approval fetched immediately AFTER creation —
 * the server's actual resolved manifest — and the caller must ONLY
 * pre-approve when this reports `matches: true`.
 *
 * Compares EXACTLY the fields {@link DisplayedExecutionContext} carries —
 * the same set the banner renders — and no others:
 *   - title, description          (the untrusted content itself)
 *   - serverName
 *   - workingDirectory
 *   - branches.base / .target / .work
 *   - phases                      (ordered enabled-phase-name list)
 *   - repository (owner/repoName)
 *   - secretNames                 (as a set — order-independent)
 *
 * This list must never grow silently: a field compared here but not shown
 * in the banner would reject on drift the human had no way to notice, and a
 * field shown in the banner but not compared here would let the human
 * approve content the fingerprint covers but they never actually saw. Keep
 * DisplayedExecutionContext, UntrustedImportBanner's props, and this
 * function's field list in lockstep.
 */
export function compareExecutionApprovalContext(
  displayed: DisplayedExecutionContext,
  actual: DisplayedExecutionContext,
): { matches: true } | { matches: false; mismatches: string[] } {
  const mismatches: string[] = [];
  if (displayed.title !== actual.title) mismatches.push('title');
  if (displayed.description !== actual.description) mismatches.push('description');
  if ((displayed.serverName || null) !== (actual.serverName || null)) mismatches.push('serverName');
  if ((displayed.workingDirectory || null) !== (actual.workingDirectory || null)) mismatches.push('workingDirectory');
  if (displayed.branches.base !== actual.branches.base) mismatches.push('baseBranch');
  if (displayed.branches.target !== actual.branches.target) mismatches.push('targetBranch');
  if (displayed.branches.work !== actual.branches.work) mismatches.push('workBranch');
  if (displayed.phases.join(' ') !== actual.phases.join(' ')) mismatches.push('phases');
  const displayedRepo = displayed.repository ? `${displayed.repository.owner}/${displayed.repository.repoName}` : '';
  const actualRepo = actual.repository ? `${actual.repository.owner}/${actual.repository.repoName}` : '';
  if (displayedRepo !== actualRepo) mismatches.push('repository');
  const displayedSecrets = [...displayed.secretNames].sort().join(' ');
  const actualSecrets = [...actual.secretNames].sort().join(' ');
  if (displayedSecrets !== actualSecrets) mismatches.push('secretNames');
  return mismatches.length === 0 ? { matches: true } : { matches: false, mismatches };
}
