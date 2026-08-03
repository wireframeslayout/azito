import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FileDiff } from './types';
import { STATUS_COLOR } from './types';

interface DiffFileListProps {
  files: FileDiff[];
  activeFile: string | null;
  onFileClick: (file: string) => void;
}

export default function DiffFileList({ files, activeFile, onFileClick }: DiffFileListProps) {
  const { t } = useTranslation('git');
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

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
      <div style={{ flex: 1, overflowY: 'auto' }} role="listbox" aria-label={t('diff.changedFiles')}>
        {files.map((f) => {
          const isActive = activeFile === f.file;
          const lastSlash = f.file.lastIndexOf('/');
          const dir = lastSlash >= 0 ? f.file.slice(0, lastSlash + 1) : '';
          const name = lastSlash >= 0 ? f.file.slice(lastSlash + 1) : f.file;

          return (
            <button
              key={f.file}
              role="option"
              aria-selected={isActive}
              onClick={() => onFileClick(f.file)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '5px 12px',
                background: isActive ? 'var(--bg-hover)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text)',
                fontSize: 'var(--font-sm)',
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 'var(--font-2xs)',
                  width: 12,
                  textAlign: 'center',
                  color: STATUS_COLOR[f.status] || 'var(--text)',
                  flexShrink: 0,
                }}
              >
                {f.status}
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
                }}
              >
                {dir && <span style={{ color: 'var(--text-dim)' }}>{dir}</span>}
                {name}
              </span>
              <span style={{ fontSize: 'var(--font-2xs)', flexShrink: 0, display: 'flex', gap: 4 }}>
                {f.additions > 0 && (
                  <span style={{ color: 'var(--success)' }}>+{f.additions}</span>
                )}
                {f.deletions > 0 && (
                  <span style={{ color: 'var(--danger)' }}>-{f.deletions}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
