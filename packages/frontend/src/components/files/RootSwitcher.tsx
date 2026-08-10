import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { WorktreePickerItem, getWorktreeName } from './WorktreePickerItem';

export interface WorktreeItem {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  taskId: number | null;
  taskTitle: string | null;
  taskStatus: string | null;
  orphaned: boolean;
  changedCount: number | null;
}

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'waiting_input', 'phase_review', 'pending_approval']);

interface RootSwitcherProps {
  serverName: string;
  projectId: number;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onWorktreeChange?: (worktree: WorktreeItem | null) => void;
}

export function RootSwitcher({ serverName, projectId, selectedPath, onSelect, onWorktreeChange }: RootSwitcherProps) {
  const { t } = useTranslation('files');
  const [open, setOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [currentWorktree, setCurrentWorktree] = useState<WorktreeItem | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const onWorktreeChangeRef = useRef(onWorktreeChange);
  onWorktreeChangeRef.current = onWorktreeChange;

  const fetchWorktrees = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ worktrees: WorktreeItem[] }>(
        `/servers/${encodeURIComponent(serverName)}/git/worktrees?project_id=${projectId}`,
      );
      setWorktrees(data.worktrees);
      const current = findCurrent(data.worktrees, selectedPath);
      setCurrentWorktree(current);
      onWorktreeChangeRef.current?.(current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverName, projectId, selectedPath]);

  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

  const handleOpen = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    setFilter('');
    setHighlightIdx(0);
    setOpen(true);
    fetchWorktrees();
    setTimeout(() => filterRef.current?.focus(), 0);
  }, [open, fetchWorktrees]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [open]);

  const filtered = worktrees.filter((w) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    const name = getWorktreeName(w).toLowerCase();
    const branch = (w.branch ?? '').toLowerCase();
    const taskMatch = w.taskId != null && `#${w.taskId}`.includes(q);
    return name.includes(q) || branch.includes(q) || taskMatch;
  });

  const scrollToItem = (idx: number) => {
    if (!listRef.current) return;
    const items = listRef.current.children;
    if (items[idx]) (items[idx] as HTMLElement).scrollIntoView({ block: 'nearest' });
  };

  const handleSelect = useCallback((worktree: WorktreeItem) => {
    onSelect(worktree.isMain ? null : worktree.path);
    setCurrentWorktree(worktree);
    onWorktreeChangeRef.current?.(worktree);
    setOpen(false);
  }, [onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (filtered.length === 0 && e.key !== 'Escape') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((prev) => {
        const next = Math.min(prev + 1, filtered.length - 1);
        scrollToItem(next);
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((prev) => {
        const next = Math.max(prev - 1, 0);
        scrollToItem(next);
        return next;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIdx]) handleSelect(filtered[highlightIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }, [filtered, highlightIdx, handleSelect]);

  const name = currentWorktree ? getWorktreeName(currentWorktree) : '…';
  const isRunning = currentWorktree?.taskStatus != null && RUNNING_STATUSES.has(currentWorktree.taskStatus);

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* Switcher row */}
      <button
        type="button"
        onClick={handleOpen}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          width: '100%',
          padding: '8px 12px',
          background: 'var(--bg-card)',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text)',
          textAlign: 'left',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span
              style={{
                fontSize: 'var(--font-sm)',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {name}
            </span>
            <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {currentWorktree?.isMain && <Badge tone="neutral">{t('worktrees.mainLabel')}</Badge>}
              {currentWorktree?.taskId != null && isRunning && <Badge tone="green">#{currentWorktree.taskId}</Badge>}
              {currentWorktree?.taskId != null && !isRunning && <Badge tone="neutral">#{currentWorktree.taskId}</Badge>}
              {currentWorktree?.orphaned && <Badge tone="orange">{t('worktrees.orphaned')}</Badge>}
              {currentWorktree?.changedCount != null && currentWorktree.changedCount > 0 && (
                <Badge tone="accent">{t('worktrees.changedFiles', { count: currentWorktree.changedCount })}</Badge>
              )}
            </span>
          </div>
          {currentWorktree?.branch && (
            <div
              style={{
                fontSize: 'var(--font-xs)',
                color: 'var(--text-dim)',
                fontFamily: 'var(--mono)',
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {currentWorktree.branch}
            </div>
          )}
        </div>
        <Icon
          name="chevron-down"
          size={14}
          rotate={open ? 180 : 0}
          style={{ flexShrink: 0, color: 'var(--text-dim)', marginTop: 2 }}
        />
      </button>

      {/* Picker popover */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            background: 'var(--bg-solid)',
            boxShadow: 'var(--shadow-2)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
          onKeyDown={handleKeyDown}
        >
          {/* Filter input */}
          <div style={{ padding: '8px 8px 4px' }}>
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setHighlightIdx(0); }}
              placeholder={t('rootSwitcher.filter')}
              style={{
                width: '100%',
                padding: '6px 8px',
                background: 'var(--input-bg)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text)',
                fontSize: 'var(--font-sm)',
                outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.boxShadow = '0 0 0 1px var(--accent-a35)'; }}
              onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
            />
          </div>

          {/* List */}
          <div
            ref={listRef}
            role="listbox"
            style={{ maxHeight: 232, overflowY: 'auto', padding: '4px 0' }}
          >
            {loading && (
              <div style={{ padding: '4px 12px' }} aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      height: 38,
                      marginBottom: 2,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-hover)',
                      animation: 'pulse 1.5s ease-in-out infinite',
                      animationDelay: `${i * 0.15}s`,
                    }}
                  />
                ))}
                <style>{'@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }'}</style>
              </div>
            )}
            {!loading && error && (
              <div style={{ padding: '8px 12px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }} role="alert">
                <span>{t('worktrees.loadError')}</span>
                <button
                  type="button"
                  onClick={fetchWorktrees}
                  style={{
                    marginLeft: 8,
                    color: 'var(--accent)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 'var(--font-sm)',
                    textDecoration: 'underline',
                  }}
                >
                  {t('worktrees.retry')}
                </button>
              </div>
            )}
            {!loading && !error && filtered.map((worktree, i) => {
              const isSelected = selectedPath === worktree.path || (worktree.isMain && selectedPath === null);
              return (
                <WorktreePickerItem
                  key={worktree.path}
                  item={worktree}
                  isSelected={isSelected}
                  isHighlighted={i === highlightIdx}
                  onClick={() => handleSelect(worktree)}
                />
              );
            })}
          </div>

          {/* Footer */}
          {!loading && !error && (
            <div
              style={{
                padding: '6px 12px',
                fontSize: 'var(--font-xs)',
                color: 'var(--text-dim)',
                display: 'flex',
                justifyContent: 'space-between',
                borderTop: '1px solid var(--hairline)',
              }}
            >
              <span>{t('rootSwitcher.footerCount', { count: filtered.length })}</span>
              <span style={{ opacity: 0.7 }}>{t('rootSwitcher.footerHint')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function findCurrent(worktrees: WorktreeItem[], selectedPath: string | null): WorktreeItem | null {
  if (selectedPath === null) return worktrees.find((w) => w.isMain) ?? null;
  return worktrees.find((w) => w.path === selectedPath) ?? null;
}
