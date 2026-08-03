import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import DiffHunkView from './DiffHunkView';
import type { FileDiff } from './types';
import { STATUS_COLOR } from './types';
import { Icon } from '../ui/Icon';

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.json': 'json', '.css': 'css', '.html': 'html',
  '.md': 'markdown', '.py': 'python',
  '.sh': 'shell', '.bash': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.sql': 'sql',
};

function getLanguage(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.'));
  return EXT_LANG[ext] || '';
}

const LARGE_FILE_THRESHOLD = 1000;

interface DiffContentProps {
  files: FileDiff[];
  activeFile: string | null;
  fileRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
}

export default function DiffContent({ files, activeFile, fileRefs }: DiffContentProps) {
  const { t } = useTranslation('git');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const f of files) {
      const totalLines = f.hunks.reduce((sum, h) => sum + h.lines.length, 0);
      if (totalLines > LARGE_FILE_THRESHOLD) initial.add(f.file);
    }
    return initial;
  });

  const toggleCollapse = (file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  return (
    <div style={{ overflowY: 'auto', height: '100%' }}>
      {files.map((f) => {
        const isCollapsed = collapsed.has(f.file);
        const language = getLanguage(f.file);
        const isActive = activeFile === f.file;
        const totalLines = f.hunks.reduce((sum, h) => sum + h.lines.length, 0);

        return (
          <div
            key={f.file}
            ref={(el) => {
              if (el) fileRefs.current.set(f.file, el);
            }}
            style={{
              borderBottom: '1px solid var(--border)',
              outline: isActive ? '1px solid var(--accent)' : 'none',
              outlineOffset: -1,
            }}
          >
            <button
              onClick={() => toggleCollapse(f.file)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 12px',
                background: 'var(--bg-card)',
                border: 'none',
                borderBottom: isCollapsed ? 'none' : '1px solid var(--border)',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text)',
                fontSize: 'var(--font-md)',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: 'var(--text-dim)',
                  flexShrink: 0,
                }}
              >
                <Icon name="chevron-right" size={14} rotate={isCollapsed ? 0 : 90} />
              </span>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 'var(--font-xs)',
                  width: 14,
                  textAlign: 'center',
                  color: STATUS_COLOR[f.status] || 'var(--text)',
                  flexShrink: 0,
                }}
              >
                {f.status}
              </span>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: 'var(--font-sm)',
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.file}
              </span>
              {f.isBinary ? (
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>{t('diff.binary')}</span>
              ) : (
                <span style={{ fontSize: 'var(--font-xs)', flexShrink: 0, display: 'flex', gap: 6 }}>
                  {f.additions > 0 && (
                    <span style={{ color: 'var(--success)' }}>+{f.additions}</span>
                  )}
                  {f.deletions > 0 && (
                    <span style={{ color: 'var(--danger)' }}>-{f.deletions}</span>
                  )}
                </span>
              )}
              {totalLines > LARGE_FILE_THRESHOLD && (
                <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--warning)', flexShrink: 0 }}>
                  {t('diff.largeFile')}
                </span>
              )}
            </button>
            {!isCollapsed && !f.isBinary && f.hunks.map((hunk, hi) => (
              <DiffHunkView key={hi} hunk={hunk} language={language} />
            ))}
            {!isCollapsed && f.isBinary && (
              <div style={{ padding: '16px 12px', color: 'var(--text-dim)', fontSize: 'var(--font-sm)', textAlign: 'center' }}>
                {t('diff.binaryNotShown')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
