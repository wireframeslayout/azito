export const RUNNING_STATUSES = new Set(['running', 'in_progress', 'phase_review', 'waiting_input']);

const STATUS_KEY_MAP: Record<string, string> = { waiting_input: 'waitingInput', phase_review: 'phaseReview', pending_approval: 'pendingApproval', in_progress: 'inProgress' };
export function statusLabelKey(status: string): string { return STATUS_KEY_MAP[status] ?? status; }
