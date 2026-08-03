import React from 'react';
import { Icon } from '../ui/Icon';

export default function PhaseProgressBar({ status, currentPhase, phases, selfReviewCount, selfReviewMax }: {
  status: string;
  currentPhase?: string | null;
  phases: Array<{ name: string; label: string }>;
  selfReviewCount?: number;
  selfReviewMax?: number;
}) {
  const phaseForIndex = currentPhase ?? null;
  const currentIndex = phaseForIndex ? phases.findIndex((p) => p.name === phaseForIndex) : -1;
  const isPhaseReview = status === 'phase_review';
  const isWaitingInput = status === 'waiting_input';

  const getState = (idx: number): string => {
    if (status === 'done' || status === 'review') return 'completed';
    if (status === 'failed') {
      const failIdx = Math.max(currentIndex, 0);
      return idx < failIdx ? 'completed' : idx === failIdx ? 'failed' : 'pending';
    }
    if (isPhaseReview || isWaitingInput) {
      const activeIdx = Math.max(currentIndex, 0);
      return idx < activeIdx ? 'completed' : idx === activeIdx ? 'active' : 'pending';
    }
    if (status === 'running' && currentIndex >= 0) {
      if (idx < currentIndex) return 'completed';
      if (idx === currentIndex) return 'active';
      return 'pending';
    }
    if (currentIndex < 0) return 'pending';
    if (idx < currentIndex) return 'completed';
    if (idx === currentIndex) return 'active';
    return 'pending';
  };

  const relevantStatuses = ['running', 'phase_review', 'done', 'review', 'waiting_input', 'failed', 'in_progress'];
  if (!relevantStatuses.includes(status) || phases.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', gap: 0, borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', flexShrink: 0 }}>
      {phases.map((phase, idx) => {
        const state = getState(idx);
        return (
          <React.Fragment key={phase.name}>
            {idx > 0 && (
              <div style={{ flex: 1, height: 2, background: state === 'completed' || getState(idx - 1) === 'completed' ? 'var(--success)' : 'var(--border)', minWidth: 8 }} />
            )}
            {idx > 0 && idx === currentIndex + 1 && isPhaseReview && currentIndex === 0 && (
              <>
                <div style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-2xs)', background: 'rgba(255,166,0,0.15)', color: '#ffa600', border: '2px solid #ffa600', flexShrink: 0 /* lint-allow: hex - dedicated "plan review pending" attention color, not part of the success/warning/danger triad yet */ }}>!</div>
                <div style={{ flex: 1, height: 2, background: 'var(--border)', minWidth: 8 }} />
              </>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--font-xs)', fontWeight: 600,
                ...(state === 'completed' ? { background: 'var(--success-a15)', color: 'var(--success)', border: '2px solid var(--success)' } :
                    state === 'active' ? { background: 'var(--accent-a15)', color: 'var(--accent)', border: '2px solid var(--accent)' } :
                    state === 'failed' ? { background: 'var(--danger-a15)', color: 'var(--danger)', border: '2px solid var(--danger)' } :
                    { background: 'var(--bg)', color: 'var(--text-dim)', border: '2px solid var(--border)' }),
              }}>
                {state === 'completed' ? <Icon name="check" size={14} /> : state === 'failed' ? <Icon name="close" size={14} /> : state === 'active' ? '●' : '○'}
              </div>
              <span style={{ fontSize: 'var(--font-2xs)', color: state === 'active' ? 'var(--accent)' : 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                {phase.label}
                {selfReviewCount != null && selfReviewMax != null && selfReviewMax > 0 && idx === currentIndex && state === 'active' && selfReviewCount > 0 ? ` (${selfReviewCount}/${selfReviewMax})` : ''}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
