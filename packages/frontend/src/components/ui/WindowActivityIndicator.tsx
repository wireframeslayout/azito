import { useTranslation } from 'react-i18next';
import type { ActivityIndicator } from '../../hooks/useAgentActivity';
import { useBrailleSpinner } from '../../hooks/useBrailleSpinner';
import { formatRelativeTime } from '../../utils/time';

function FinishedIndicator() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="8" fill="var(--success)" />
      <path
        d="M4.5 8.2 7 10.7 11.5 5.7"
        stroke="#fff" // lint-allow: hex - white checkmark on solid var(--success) dot; no on-color token yet
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BrailleSpinner() {
  const frame = useBrailleSpinner();
  return (
    <span className="aw-braille-spinner" aria-hidden="true" style={{ flexShrink: 0, width: 12, textAlign: 'center', lineHeight: 1, fontSize: 'var(--font-xs)' }}>
      {frame}
    </span>
  );
}

function BlockedDot() {
  return <span className="aw-blocked-dot" aria-hidden="true" />;
}

interface WindowActivityIndicatorProps {
  status: ActivityIndicator;
  finishedAt?: number;
}

export default function WindowActivityIndicator({ status, finishedAt }: WindowActivityIndicatorProps) {
  const { t } = useTranslation('workspace');
  if (!status) return null;

  if (status === 'working') {
    return <BrailleSpinner />;
  }

  if (status === 'blocked') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <BlockedDot />
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--warning)', whiteSpace: 'nowrap' }}>
          {t('activeWindows.planReview')}
        </span>
      </span>
    );
  }

  // finished
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <FinishedIndicator />
      {finishedAt != null && (
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--success)', whiteSpace: 'nowrap' }}>
          {t('activeWindows.done')} · {formatRelativeTime(finishedAt)}
        </span>
      )}
    </span>
  );
}

export { FinishedIndicator, BrailleSpinner, BlockedDot };
