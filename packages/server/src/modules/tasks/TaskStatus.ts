// 'pending_approval': blocked by the untrusted-input execution gate (Issue #328) — distinct from
// 'phase_review' (plan approval, happens AFTER the planning worker has already run with secrets
// injected). pending_approval is set BEFORE any worker/worktree/secret ever touches the task.
export const TASK_STATUSES = ['open', 'running', 'phase_review', 'pending_approval', 'waiting_input', 'review', 'in_progress', 'done', 'failed', 'archived'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
