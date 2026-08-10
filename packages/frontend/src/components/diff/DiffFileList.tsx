import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FileDiff, DiffScope } from './types';
import { STATUS_COLOR } from './types';

interface DiffFileListProps {
  files: FileDiff[];
  activeFile: string | null;
  onFileClick: (file: string) => void;
  onOpenFile?: (relPath: string) => void;
  scope?: DiffScope;
}

export default function DiffFileList({ files, activeFile, onFileClick, onOpenFile, scope }: DiffFileListProps) {
  const { t } = useTranslation('git');
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  const showGroups = scope === 'uncommitted' && files.some((f) => f.group);

  // Group files for rendering
  const groups: { key: string; label: string; files: FileDiff[] }[] = [];
  if (showGroups) {
    const staged = files.filter((f) => f.group === 'staged');
    const unstaged = files.filter((f) => f.group === 'unstaged');
    const untracked = files.filter((f) => f.group === 'untracked');
    if (staged.length > 0) groups.push({ key: 'staged', label: t('diff.groups.staged'), files: staged });
    if (unstaged.length > 0) groups.push({ key: 'unstaged', label: t('diff.groups.unstaged'), files: unstaged });
    if (untracked.length > 0) groups.push({ key: 'untracked', label: t('diff.groups.untracked'), files: untracked });
  } else {
    groups.push({ key: 'all', label: '', files });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--font-xs)',
          color: 'var(--text-dim)',
          flexShrink: 0,
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>
          {t('diff.fileCount', { count: files.length })}
        </span>
        {totalAdditions > 0 && (
          <span style={{ color: 'var(--success)' }}>+{totalAdditions}</span>
        )}
        {totalDeletions > 0 && (
          <span style={{ color: 'var(--danger)' }}>-{totalDeletions}</span>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: showGroups ? '4px 0' : 0 }} role="listbox" aria-label={t('diff.changedFiles')}>
        {groups.map((group) => (
          <React.Fragment key={group.key}>
            {group.label && (
              <div
                style={{
                  fontSize: 'var(--font-2xs)',
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  padding: '8px 12px 3px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {group.label}
                <span
                  style={{
                    fontSize: 'var(--font-2xs)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '1px 5px',
                    color: 'var(--text-dim)',
                    background: 'var(--bg)',
                    boxShadow: 'inset 0 0 0 1px var(--hairline)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {group.files.length}
                </span>
              </div>
            )}
            {group.files.map((f) => {
              const isActive = activeFile === f.file;
              const statusLetter = f.group === 'untracked' ? 'U' : f.status;
              const statusColor = f.group === 'untracked' ? STATUS_COLOR.U : (STATUS_COLOR[f.status] || 'var(--text)');

              return (
                <button
                  key={f.file}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => onFileClick(f.file)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    width: '100%',
                    padding: '4px 12px',
                    background: isActive ? 'var(--selected-bg-strong)' : 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: 'var(--text)',
                    fontSize: 'var(--font-sm)',
                    minHeight: 26,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 'var(--font-xs)',
                      width: 13,
                      textAlign: 'center',
                      color: statusColor,
                      flexShrink: 0,
                      fontFamily: 'ui-monospace, Menlo, monospace',
                    }}
                  >
                    {statusLetter}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontFamily: 'monospace',
                      fontSize: 'var(--font-xs)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                      direction: 'rtl',
                      textAlign: 'left',
                    }}
                  >
                    <bdi>{f.file}</bdi>
                  </span>
                  <span
                    style={{
                      fontSize: 'var(--font-2xs)',
                      flexShrink: 0,
                      display: 'flex',
                      gap: 4,
                      fontVariantNumeric: 'tabular-nums',
                      color: 'var(--text-dim)',
                    }}
                  >
                    {f.additions > 0 && (
                      <span style={{ color: 'var(--success)' }}>+{f.additions}</span>
                    )}
                    {f.deletions > 0 && (
                      <span style={{ color: 'var(--danger)' }}>−{f.deletions}</span>
                    )}
                  </span>
                  {onOpenFile && (
                    <span
                      role="button"
                      tabIndex={f.status === 'D' ? -1 : 0}
                      aria-label={f.status === 'D' ? 'Deleted file cannot be opened' : `Open ${f.file} in editor`}
                      title={f.status === 'D' ? 'Deleted file cannot be opened' : 'Open in editor'}
                      className="diff-open-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (f.status !== 'D') onOpenFile(f.file);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && f.status !== 'D') {
                          e.stopPropagation();
                          onOpenFile(f.file);
                        }
                      }}
                      style={{
                        fontSize: 12,
                        flexShrink: 0,
                        opacity: 0,
                        transition: 'opacity 0.15s',
                        cursor: f.status === 'D' ? 'not-allowed' : 'pointer',
                        color: f.status === 'D' ? 'var(--text-dim)' : 'var(--accent)',
                        padding: '0 2px',
                      }}
                    >
                      ✎
                    </span>
                  )}
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
