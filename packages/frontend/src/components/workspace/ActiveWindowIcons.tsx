import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveWindowRows, type ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { BrailleSpinner } from '../ui/WindowActivityIndicator';
import { ActiveWindowDot } from '../ui/ActiveWindowDot';
import { buildWindowTaskMap, lookupWindowTask } from '../../lib/windowTask';
import { selectTaskTerminal } from './TaskPanel';

interface ActiveWindowIconsProps {
  connectPane: (serverName: string, target: string, projectId?: number) => void;
  openTask: (taskId: number, title: string, projectId?: number) => void;
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

const ITEM_HEIGHT = 48;

function useMaxVisible(containerRef: React.RefObject<HTMLDivElement | null>): number {
  const [max, setMax] = useState(4);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      setMax(Math.max(1, Math.floor(height / ITEM_HEIGHT)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  return max;
}

export default function ActiveWindowIcons({ connectPane, openTask, taskWindows }: ActiveWindowIconsProps) {
  const { t } = useTranslation(['workspace', 'tasks']);
  const { rows } = useActiveWindowRows();
  const { dismissFinished } = useAgentActivity();
  const windowTaskMap = useMemo(() => buildWindowTaskMap(taskWindows), [taskWindows]);
  const containerRef = useRef<HTMLDivElement>(null);
  const maxVisible = useMaxVisible(containerRef);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  const handleRowOpen = (row: ActiveWindowRow) => {
    const taskId = row.taskId ?? lookupWindowTask(windowTaskMap, row.serverName, row.target);
    if (taskId != null) {
      selectTaskTerminal(taskId, { serverName: row.serverName, target: row.target });
      openTask(taskId, t('tasks:detail.taskRef', { id: taskId }), row.projectId);
    } else {
      connectPane(row.serverName, row.target, row.projectId);
    }
    if (row.status === 'finished') dismissFinished(row.serverName, row.target);
  };

  useEffect(() => {
    if (!overflowOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [overflowOpen]);

  if (rows.length === 0) return null;

  const visibleRows = rows.slice(0, maxVisible);
  const overflowCount = rows.length - visibleRows.length;

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flex: 1,
        overflow: 'hidden',
        paddingTop: 8,
        position: 'relative',
      }}
    >
      {visibleRows.map((row) => (
        <ActiveWindowIconItem key={row.key} row={row} onOpen={handleRowOpen} taskWindows={windowTaskMap} />
      ))}
      {overflowCount > 0 && (
        <button
          type="button"
          onClick={() => setOverflowOpen((v) => !v)}
          title={t('activeWindows.overflow', { count: overflowCount })}
          style={{
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-md)',
            border: '1px solid transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-dim)',
            fontFamily: 'var(--mono, ui-monospace, monospace)',
            fontSize: 'var(--font-md)',
            letterSpacing: '0.05em',
            margin: '2px 0',
          }}
        >
          +{overflowCount}
        </button>
      )}
      {overflowOpen && overflowCount > 0 && (
        <div
          ref={overflowRef}
          role="menu"
          aria-label={t('activeWindows.title')}
          style={{
            position: 'absolute',
            left: '100%',
            bottom: 0,
            marginLeft: 6,
            width: 260,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 14px 36px rgba(0,0,0,.55)',
            padding: '10px 12px',
            zIndex: 130,
          }}
        >
          <div
            style={{
              fontSize: 'var(--font-2xs)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
              padding: '2px 0 6px',
            }}
          >
            {t('activeWindows.overflowFull', { count: overflowCount })}
          </div>
          {rows.slice(maxVisible).map((row) => {
            const taskId = row.taskId ?? lookupWindowTask(windowTaskMap, row.serverName, row.target);
            const displayName = row.paneName || row.label || row.target;
            const isWorking = row.status === 'running' && row.activityStatus !== 'blocked';
            return (
              <button
                key={row.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  handleRowOpen(row);
                  setOverflowOpen(false);
                }}
                className="row-hover"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: 'var(--font-sm)',
                  width: '100%',
                }}
              >
                {isWorking ? <BrailleSpinner /> : <GreenDotInline />}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName}
                </span>
                {taskId != null && (
                  <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', flexShrink: 0 }}>#{taskId}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GreenDotInline() {
  return (
    <svg viewBox="0 0 10 10" width={10} height={10} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="5" r="5" fill="var(--success)" />
      <path
        d="M2.5 5.2l1.8 1.8 3.2-3.2"
        stroke="#fff" // lint-allow: hex - white checkmark on solid var(--success) dot; no on-color token yet
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ActiveWindowIconItemProps {
  row: ActiveWindowRow;
  onOpen: (row: ActiveWindowRow) => void;
  taskWindows: Map<string, number>;
}

function ActiveWindowIconItem({ row, onOpen, taskWindows }: ActiveWindowIconItemProps) {
  const taskId = row.taskId ?? lookupWindowTask(taskWindows, row.serverName, row.target);
  const displayName = row.paneName || row.label || row.target;
  const isWorking = row.status === 'running' && row.activityStatus !== 'blocked';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 2 }}>
      <button
        type="button"
        onClick={() => onOpen(row)}
        title={displayName}
        className={isWorking ? 'aw-icon-working' : undefined}
        style={{
          width: 34,
          height: 34,
          borderRadius: 'var(--radius-md)',
          border: '1px solid transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--text-dim)',
          position: 'relative',
          margin: 0,
          padding: 0,
        }}
      >
        {isWorking ? (
          <span style={{ fontSize: 'var(--font-base)' }}>
            <BrailleSpinner />
          </span>
        ) : (
          <>
            <span
              style={{
                fontFamily: 'var(--mono, ui-monospace, monospace)',
                fontSize: 'var(--font-lg)',
                color: 'var(--text-dim)',
              }}
            >
              ✳
            </span>
            <ActiveWindowDot />
          </>
        )}
      </button>
      {taskId != null && (
        <span
          style={{
            fontFamily: 'var(--mono, ui-monospace, monospace)',
            fontSize: 'var(--font-2xs)',
            letterSpacing: '0.04em',
            color: 'var(--text-dim)',
            marginTop: 1,
          }}
        >
          #{taskId}
        </span>
      )}
    </div>
  );
}
