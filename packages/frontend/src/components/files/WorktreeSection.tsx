import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../hooks/useApi';
import { Badge } from '../ui/Badge';

interface WorktreeItem {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  taskId: number | null;
  taskTitle: string | null;
  taskStatus: string | null;
  orphaned: boolean;
}

interface WorktreeSectionProps {
  serverName: string;
  projectId: number;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'waiting_input', 'phase_review', 'pending_approval']);

function getStoredOpen(): boolean {
  try {
    const value = localStorage.getItem('azito-worktrees-open');
    return value === null ? true : value === 'true';
  } catch {
    return true;
  }
}

function getWorktreeName(worktree: WorktreeItem): string {
  if (worktree.isMain) return worktree.path.split('/').pop() ?? worktree.path;
  return worktree.path.match(/\/\.worktrees\/(.+)$/)?.[1] ?? worktree.path;
}

export function WorktreeSection({ serverName, projectId, selectedPath, onSelect }: WorktreeSectionProps) {
  const { t } = useTranslation('files');
  const [open, setOpen] = useState(getStoredOpen);
  const { data, loading, error, refresh } = useApi<{ worktrees: WorktreeItem[] }>(
    `/servers/${serverName}/git/worktrees?project_id=${projectId}`,
  );
  const worktrees = data?.worktrees ?? [];

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem('azito-worktrees-open', String(next));
    } catch {}
  };

  return (
    <div style={{ borderBottom: '1px solid var(--border)', flexShrink: 0, position: 'relative' }}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.15s ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', fontSize: 10 }}>▶</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{t('worktrees.title')}</span>
        {!loading && worktrees.length > 0 && <Badge tone="neutral" style={{ fontSize: 'var(--font-xxs)', padding: '0 5px' }}>{worktrees.length}</Badge>}
      </button>
      {open && !loading && !error && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); refresh(); }}
          title={t('explorer.refresh')}
          style={{ position: 'absolute', right: 8, top: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--font-xs)', padding: '2px 4px', opacity: 0.6 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }}
        >↻</button>
      )}
      {open && (
        <div>
          {loading && (
            <div style={{ padding: '4px 12px' }} aria-label={t('worktrees.title')} aria-busy="true">
              {[0, 1, 2].map((index) => <div key={index} style={{ height: 28, marginBottom: 2, borderRadius: 'var(--radius-sm)', background: 'var(--bg-hover)', animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${index * 0.15}s` }} />)}
              <style>{'@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }'}</style>
            </div>
          )}
          {!loading && error && (
            <div style={{ padding: '8px 12px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }} role="alert">
              <span>{t('worktrees.loadError')}</span>
              <button type="button" onClick={refresh} style={{ marginLeft: 8, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-sm)', textDecoration: 'underline' }}>{t('worktrees.retry')}</button>
            </div>
          )}
          {!loading && !error && worktrees.length === 0 && (
            <div style={{ padding: '12px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', textAlign: 'center' }}>
              {t('worktrees.empty')}
            </div>
          )}
          {!loading && !error && worktrees.map((worktree) => {
            const isSelected = selectedPath === worktree.path || (worktree.isMain && selectedPath === null);
            const isRunning = worktree.taskStatus != null && RUNNING_STATUSES.has(worktree.taskStatus);
            return (
              <button
                key={worktree.path}
                type="button"
                onClick={() => onSelect(worktree.isMain ? null : worktree.path)}
                title={worktree.path}
                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '4px 12px', paddingLeft: isSelected ? 9 : 12, background: isSelected ? 'var(--accent-a08)' : 'transparent', border: 'none', borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent', cursor: 'pointer', color: 'var(--text)', fontSize: 'var(--font-sm)', textAlign: 'left', minHeight: 28 }}
                onMouseEnter={(event) => { if (!isSelected) event.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = isSelected ? 'var(--accent-a08)' : 'transparent'; }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getWorktreeName(worktree)}</span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {worktree.isMain && <Badge tone="neutral">{t('worktrees.mainLabel')}</Badge>}
                  {worktree.taskId != null && isRunning && <Badge tone="green">#{worktree.taskId} {t('worktrees.running')}</Badge>}
                  {worktree.taskId != null && !isRunning && <Badge tone="neutral">#{worktree.taskId}</Badge>}
                  {worktree.orphaned && <Badge tone="orange">{t('worktrees.orphaned')}</Badge>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
