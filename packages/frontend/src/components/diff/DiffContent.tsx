import React, { useState, useEffect, useRef } from 'react';
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

const INITIAL_EXPAND_COUNT = 5;
const LARGE_FILE_THRESHOLD = 1000;

interface DiffContentProps {
  files: FileDiff[];
  activeFile: string | null;
  fileRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
}

function computeInitialCollapsed(files: FileDiff[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const totalLines = f.hunks.reduce((sum, h) => sum + h.lines.length, 0);
    if (i >= INITIAL_EXPAND_COUNT || totalLines > LARGE_FILE_THRESHOLD) {
      s.add(f.file);
    }
  }
  return s;
}

function computeInitialExpanded(files: FileDiff[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < Math.min(files.length, INITIAL_EXPAND_COUNT); i++) {
    const f = files[i];
    const totalLines = f.hunks.reduce((sum, h) => sum + h.lines.length, 0);
    if (totalLines <= LARGE_FILE_THRESHOLD) {
      s.add(f.file);
    }
  }
  return s;
}

export default function DiffContent({ files, activeFile, fileRefs }: DiffContentProps) {
  const { t } = useTranslation('git');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => computeInitialCollapsed(files));
  const [expanded, setExpanded] = useState<Set<string>>(() => computeInitialExpanded(files));
  const prevFilesRef = useRef(files);

  useEffect(() => {
    if (prevFilesRef.current !== files) {
      prevFilesRef.current = files;
      setCollapsed(computeInitialCollapsed(files));
      setExpanded(computeInitialExpanded(files));
    }
  }, [files]);

  const toggleCollapse = (file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) {
        next.delete(file);
        setExpanded((prev2) => new Set(prev2).add(file));
      } else {
        next.add(file);
      }
      return next;
    });
  };

  return (
    <div style={{ overflowY: 'auto', height: '100%', padding: '10px 12px' }}>
      {files.map((f) => {
        const isCollapsed = collapsed.has(f.file);
        const hasBeenExpanded = expanded.has(f.file);
        const language = getLanguage(f.file);
        const isActive = activeFile === f.file;
        const statusLetter = f.group === 'untracked' ? 'U' : f.status;
        const statusColor = f.group === 'untracked' ? STATUS_COLOR.U : (STATUS_COLOR[f.status] || 'var(--text)');

        return (
          <div
            key={f.file}
            ref={(el) => {
              if (el) fileRefs.current.set(f.file, el);
            }}
            style={{
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-card)',
              boxShadow: 'inset 0 1px 0 var(--edge-hi)',
              marginBottom: 10,
              overflow: 'hidden',
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
                padding: '7px 12px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text)',
                fontSize: 'var(--font-sm)',
                fontFamily: 'ui-monospace, Menlo, monospace',
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
                  fontWeight: 700,
                  fontSize: 'var(--font-xs)',
                  width: 13,
                  textAlign: 'center',
                  color: statusColor,
                  flexShrink: 0,
                }}
              >
                {statusLetter}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.file}
              </span>
              {f.group === 'untracked' && (
                <span
                  style={{
                    fontSize: 'var(--font-2xs)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '1px 5px',
                    color: 'var(--accent)',
                    background: 'var(--accent-a08)',
                    boxShadow: 'inset 0 0 0 1px var(--accent-a35)',
                    marginLeft: 2,
                    flexShrink: 0,
                  }}
                >
                  {t('diff.untracked')}
                </span>
              )}
              {f.isBinary ? (
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>{t('diff.binary')}</span>
              ) : (
                <span
                  style={{
                    fontSize: 'var(--font-2xs)',
                    flexShrink: 0,
                    display: 'flex',
                    gap: 6,
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-dim)',
                    marginLeft: 'auto',
                  }}
                >
                  {f.additions > 0 && (
                    <span style={{ color: 'var(--success)' }}>+{f.additions}</span>
                  )}
                  {f.deletions > 0 && (
                    <span style={{ color: 'var(--danger)' }}>−{f.deletions}</span>
                  )}
                </span>
              )}
            </button>
            {!isCollapsed && hasBeenExpanded && !f.isBinary && f.hunks.map((hunk, hi) => (
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
