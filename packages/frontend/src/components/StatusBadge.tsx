import { useTranslation } from 'react-i18next';
import { Chip } from './ui';
import type { ChipTone } from './ui';

const STATUS_TONE: Record<string, ChipTone> = {
  open: 'accent',
  running: 'orange',
  phase_review: 'accent',
  pending_approval: 'red',
  review: 'accent',
  waiting_input: 'accent',
  in_progress: 'orange',
  done: 'green',
  failed: 'red',
  archived: 'default',
  busy: 'green',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  waiting_input: 'status.waitingInput',
  phase_review: 'status.planReview',
  pending_approval: 'status.pendingApproval',
  archived: 'status.archived',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function StatusBadge({ status, currentPhase }: { status: string; currentPhase?: string | null }) {
  const { t } = useTranslation('common');
  const tone = STATUS_TONE[status] ?? 'default';
  const labelKey = STATUS_LABEL_KEYS[status];
  const label = status === 'running' && currentPhase
    ? capitalize(currentPhase)
    : (labelKey ? t(labelKey) : status);
  return <Chip tone={tone}>{label}</Chip>;
}

const DOT_COLORS: Record<string, string> = {
  idle: 'var(--text-dim)',
  busy: 'var(--success)',
  error: 'var(--danger)',
  offline: 'var(--border)',
  open: 'var(--accent)',
  running: 'var(--warning)',
  phase_review: 'var(--accent)',
  pending_approval: 'var(--danger)',
  review: 'var(--accent)',
  waiting_input: 'var(--accent)',
  in_progress: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--danger)',
  archived: 'var(--text-dim)',
};

export function StatusDot({ status }: { status: string }) {
  const color = DOT_COLORS[status] || 'var(--text-dim)';
  const isBusy = status === 'busy';
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        display: 'inline-block',
        flexShrink: 0,
        background: color,
        animation: isBusy ? 'pulse 1.5s infinite' : undefined,
      }}
    />
  );
}
