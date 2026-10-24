import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { LoadingState, EmptyState } from '../ui';
import { InlineToggle } from '../ui/InlineToggle';
import DiffFileList from './DiffFileList';
import DiffContent from './DiffContent';
import CommitList from './CommitList';
import type { DiffResponse, DiffScope } from './types';
import { Icon } from '../ui/Icon';

interface DiffViewerProps {
  serverName: string;
  path: string;
  baseBranch?: string;
  commit?: string;
  initialFile?: string | null;
  onOpenFile?: (relPath: string) => void;
}

export default function DiffViewer({ serverName, path, baseBranch, commit: commitProp, initialFile, onOpenFile }: DiffViewerProps) {
  const { t } = useTranslation('git');

  // Derive initial scope from props
  const initialScope: DiffScope = commitProp ? 'commit' : (baseBranch ? 'base' : 'uncommitted');
  const [scope, setScope] = useState<DiffScope>(initialScope);
  const [includeUncommitted, setIncludeUncommitted] = useState(true);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(commitProp || null);
  const [commitDropdownOpen, setCommitDropdownOpen] = useState(false);
  const commitDropdownRef = useRef<HTMLDivElement>(null);

  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileListOpen, setFileListOpen] = useState(() => !window.matchMedia('(max-width: 768px)').matches);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Build fetch params based on scope
  const fetchDiff = useCallback(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setActiveFile(null);
    fileRefs.current.clear();

    const params = new URLSearchParams({ path });

    if (scope === 'uncommitted') {
      params.set('scope', 'uncommitted');
    } else if (scope === 'base') {
      if (baseBranch) params.set('base', baseBranch);
      params.set('scope', 'base');
      params.set('includeUncommitted', String(includeUncommitted));
    } else if (scope === 'commit') {
      if (!selectedCommit) {
        setLoading(false);
        return;
      }
      params.set('commit', selectedCommit);
      params.set('scope', 'commit');
    }

    api<DiffResponse & { error?: string }>(`/servers/${serverName}/git/diff?${params.toString()}`)
      .then((res) => {
        if (res.error) throw new Error(res.error);
        if (!Array.isArray(res.files)) throw new Error(t('diff.errors.invalidResponse'));
        setData(res);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('diff.errors.loadFailed')))
      .finally(() => setLoading(false));
  }, [serverName, path, baseBranch, scope, includeUncommitted, selectedCommit, t]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  useEffect(() => {
    if (data && initialFile) {
      setActiveFile(initialFile);
      requestAnimationFrame(() => {
        const el = fileRefs.current.get(initialFile);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [data, initialFile]);

  // Close commit dropdown on outside click
  useEffect(() => {
    if (!commitDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (commitDropdownRef.current && !commitDropdownRef.current.contains(e.target as Node)) {
        setCommitDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [commitDropdownOpen]);

  const handleFileClick = useCallback((file: string) => {
    setActiveFile(file);
    const el = fileRefs.current.get(file);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleScopeChange = (newScope: DiffScope) => {
    if (newScope === scope) return;
    if (newScope === 'commit') {
      setCommitDropdownOpen(true);
      return;
    }
    setScope(newScope);
    setCommitDropdownOpen(false);
    setSelectedCommit(null);
  };

  const handleCommitSelect = (hash: string) => {
    setSelectedCommit(hash);
    setScope('commit');
    setCommitDropdownOpen(false);
  };

  const totalAdditions = data?.files.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDeletions = data?.files.reduce((s, f) => s + f.deletions, 0) ?? 0;
  const fileCount = data?.files.length ?? 0;

  const scopeLabel = (s: DiffScope): string => {
    if (s === 'uncommitted') return t('diff.scope.uncommitted');
    if (s === 'base') return baseBranch ? t('diff.scope.base', { base: baseBranch }) : t('diff.scope.base', { base: 'HEAD' });
    return t('diff.scope.commit');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ws-surface)' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          background: 'var(--ws-surface)',
          flexShrink: 0,
          flexWrap: 'wrap',
          minHeight: 44,
        }}
      >
        <span style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text)' }}>
          {t('diff.changes')}
        </span>

        {/* Scope segment control */}
        <div
          role="tablist"
          style={{
            display: 'inline-flex',
            background: 'var(--bg)',
            borderRadius: 'var(--radius-md)',
            padding: 2,
            gap: 2,
          }}
        >
          {(['uncommitted', 'base', 'commit'] as const).map((s) => {
            const isActive = scope === s;
            const label = s === 'commit' ? `${scopeLabel(s)} ▾` : scopeLabel(s);
            return (
              <span
                key={s}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                onClick={() => handleScopeChange(s)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleScopeChange(s); } }}
                style={{
                  padding: '3px 10px',
                  borderRadius: 7,
                  fontSize: 'var(--font-sm)',
                  color: isActive ? 'var(--text)' : 'var(--text-dim)',
                  background: isActive ? 'var(--bg-elevated)' : 'transparent',
                  boxShadow: isActive ? 'inset 0 1px 0 var(--edge-hi)' : 'none',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  userSelect: 'none',
                  transition: 'background 0.12s, color 0.12s',
                }}
              >
                {label}
              </span>
            );
          })}
        </div>

        {/* Include uncommitted toggle (base scope only) */}
        {scope === 'base' && (
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--font-sm)',
              color: 'var(--text-dim)',
              cursor: 'pointer',
            }}
          >
            <InlineToggle
              active={includeUncommitted}
              onClick={() => setIncludeUncommitted((v) => !v)}
              title={t('diff.includeUncommitted')}
            >
              ✓
            </InlineToggle>
            {t('diff.includeUncommitted')}
          </label>
        )}

        {/* Stats */}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--font-sm)',
            color: 'var(--text-dim)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {fileCount > 0 && (
            <>
              {t('diff.fileCount', { count: fileCount })}
              {' · '}
              {totalAdditions > 0 && <span style={{ color: 'var(--success)' }}>+{totalAdditions}</span>}
              {totalAdditions > 0 && totalDeletions > 0 && ' '}
              {totalDeletions > 0 && <span style={{ color: 'var(--danger)' }}>−{totalDeletions}</span>}
            </>
          )}
          {data?.truncated && (
            <span style={{ color: 'var(--warning)', fontSize: 'var(--font-xs)', marginLeft: 8 }}>
              {t('diff.truncated')}
            </span>
          )}
        </span>
      </div>

      {/* Commit dropdown (positioned absolute) */}
      {commitDropdownOpen && (
        <div
          ref={commitDropdownRef}
          style={{
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 14,
              right: 14,
              zIndex: 10,
              maxHeight: 320,
              background: 'var(--bg-solid)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-3)',
              overflow: 'hidden',
            }}
          >
            <CommitList
              serverName={serverName}
              path={path}
              baseBranch={baseBranch}
              selectedHash={selectedCommit}
              onSelectCommit={handleCommitSelect}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      {loading ? (
        <div style={{ flex: 1 }}><LoadingState /></div>
      ) : error ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--font-md)', padding: 24 }}>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('diff.errors.loadTitle')}</div>
            <div style={{ color: 'var(--text-dim)' }}>{error}</div>
          </div>
        </div>
      ) : (!data || !data.files || data.files.length === 0) ? (
        <div style={{ flex: 1 }}><EmptyState title={t('diff.noChanges')} description={t('diff.noChangesDescription')} /></div>
      ) : (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {/* File list sidebar */}
          {fileListOpen ? (
            <div style={{ display: 'flex', flexShrink: 0 }}>
              <div
                style={{
                  width: 230,
                  flexShrink: 0,
                  background: 'var(--ws-surface-card)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <DiffFileList
                  files={data.files}
                  activeFile={activeFile}
                  onFileClick={handleFileClick}
                  onOpenFile={onOpenFile}
                  scope={scope}
                />
              </div>
              <button
                onClick={() => setFileListOpen(false)}
                title={t('diff.hideFileList')}
                aria-label={t('diff.hideFileList')}
                className="icon-btn"
                style={{
                  border: 'none',
                  borderRight: '1px solid var(--border)',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  padding: '0 4px',
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Icon name="chevron-left" size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setFileListOpen(true)}
              title={t('diff.showFileList')}
              aria-label={t('diff.showFileList')}
              className="icon-btn"
              style={{
                border: 'none',
                borderRight: '1px solid var(--border)',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                padding: '0 6px',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="chevron-right" size={14} />
            </button>
          )}

          {/* Main diff content */}
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <DiffContent
              files={data.files}
              activeFile={activeFile}
              fileRefs={fileRefs}
            />
          </div>
        </div>
      )}
    </div>
  );
}
