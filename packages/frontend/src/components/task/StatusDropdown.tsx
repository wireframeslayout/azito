import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// タスクが「実行中」（何らかの形で走っている/一時停止中で継続の見込みがある）とみなす status 集合。
// フェーズ実行中の主状態は 'running'、follow-up 中断時は 'in_progress'、計画承認待ち/質問回答待ちは
// 'phase_review'/'waiting_input'。他の実行中判定（例: オペレーション停止メニューの表示条件）でも
// この集合を再利用する。
export const RUNNING_STATUSES = new Set([
  'running', 'in_progress', 'phase_review', 'waiting_input',
]);

// 'pending_approval' is locked the same way — never a MANUAL_OPTIONS target
// and never selectable while current (see isDisabled below). Manually
// overwriting status away from pending_approval would leave the task's
// pendingOperation/executionApprovedFingerprintHash bookkeeping stuck
// mid-gate without ever consuming the approval decision (Issue #51) — the
// only valid way out is POST /api/tasks/:id/approve-execution (the
// dedicated approval panel), which atomically clears that state.
const LOCKED_STATUSES = new Set(['archived', 'pending_approval']);

const MANUAL_OPTIONS = ['open', 'done'] as const;

const badgeColors: Record<string, { bg: string; color: string }> = {
  open: { bg: 'var(--accent-a15)', color: 'var(--accent)' },
  running: { bg: 'var(--warning-a15)', color: 'var(--warning)' },
  phase_review: { bg: 'var(--accent-a15)', color: 'var(--accent)' },
  pending_approval: { bg: 'var(--danger-a15)', color: 'var(--danger)' },
  review: { bg: 'var(--accent-a15)', color: 'var(--accent)' },
  waiting_input: { bg: 'var(--accent-a15)', color: 'var(--accent)' },
  in_progress: { bg: 'var(--warning-a15)', color: 'var(--warning)' },
  done: { bg: 'var(--success-a15)', color: 'var(--success)' },
  failed: { bg: 'var(--danger-a15)', color: 'var(--danger)' },
  archived: { bg: 'var(--bg-elevated)', color: 'var(--text-dim)' },
};

const STATUS_KEY_MAP: Record<string, string> = {
  waiting_input: 'waitingInput',
  phase_review: 'phaseReview',
  pending_approval: 'pendingApproval',
  in_progress: 'inProgress',
};

function statusLabel(status: string, t: (key: string) => string): string {
  const key = STATUS_KEY_MAP[status] ?? status;
  return t(`status.${key}`);
}

interface StatusDropdownProps {
  status: string;
  onChange: (newStatus: string) => void;
  disabled?: boolean;
  /** トリガー内、ラベルの前にステータスドット（--radius-full の小円）を描く。
   * SP タスク詳細メニューのステータスチップ（Issue #338 T1）向け — 省略時は非表示（既存デスクトップ
   * 表示は StatusDot を隣接配置しているため変更不要）。 */
  showDot?: boolean;
}

export default function StatusDropdown({ status, onChange, disabled, showDot }: StatusDropdownProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isRunning = RUNNING_STATUSES.has(status);
  const isDisabled = disabled || isRunning || LOCKED_STATUSES.has(status);

  const handleToggle = useCallback(() => {
    if (!isDisabled) setOpen((v) => !v);
  }, [isDisabled]);

  const handleSelect = useCallback((newStatus: string) => {
    setOpen(false);
    if (newStatus !== status) onChange(newStatus);
  }, [status, onChange]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const colors = badgeColors[status] || badgeColors.open;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={handleToggle}
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          fontSize: 'var(--font-xs)',
          padding: '2px 8px',
          borderRadius: 'var(--radius-md)',
          fontWeight: 500,
          background: colors.bg,
          color: colors.color,
          border: 'none',
          cursor: isDisabled ? 'default' : 'pointer',
          opacity: isDisabled ? 0.7 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          transition: 'opacity 0.15s',
        }}
      >
        {showDot && (
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: 'var(--radius-full)', background: colors.color, flexShrink: 0 }}
          />
        )}
        {statusLabel(status, t)}
        {!isDisabled && (
          <span style={{ fontSize: 'var(--font-2xs)', marginLeft: 2 }}>&#9662;</span>
        )}
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 100,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            minWidth: 100,
            padding: '4px 0',
          }}
        >
          {MANUAL_OPTIONS.map((opt) => {
            const optColors = badgeColors[opt] || badgeColors.open;
            const isActive = opt === status;
            return (
              <div
                key={opt}
                role="option"
                aria-selected={isActive}
                onClick={() => handleSelect(opt)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelect(opt); }}
                tabIndex={0}
                className={isActive ? undefined : 'row-hover'}
                style={{
                  padding: '6px 12px',
                  fontSize: 'var(--font-sm)',
                  cursor: 'pointer',
                  color: isActive ? optColors.color : 'var(--text)',
                  background: isActive ? optColors.bg : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: optColors.color, flexShrink: 0,
                }} />
                {statusLabel(opt, t)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
