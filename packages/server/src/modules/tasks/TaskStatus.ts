export const TASK_STATUSES = ['open', 'running', 'phase_review', 'waiting_input', 'review', 'in_progress', 'done', 'failed', 'archived'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
