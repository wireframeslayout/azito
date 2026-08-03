import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { LoadingState, EmptyState } from '../ui';
import DiffFileList from './DiffFileList';
import DiffContent from './DiffContent';
import type { DiffResponse } from './types';
import { Icon } from '../ui/Icon';

interface DiffViewerProps {
  serverName: string;
  path: string;
  baseBranch?: string;
  commit?: string;
  initialFile?: string | null;
}

export default function DiffViewer({ serverName, path, baseBranch, commit, initialFile }: DiffViewerProps) {
  const { t } = useTranslation('git');
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileListOpen, setFileListOpen] = useState(() => !window.matchMedia('(max-width: 768px)').matches);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setActiveFile(null);
    fileRefs.current.clear();

    const params = new URLSearchParams({ path });
    if (baseBranch) params.set('base', baseBranch);
    if (commit) params.set('commit', commit);

    api<DiffResponse & { error?: string }>(`/servers/${serverName}/git/diff?${params.toString()}`)
      .then((res) => {
        if (res.error) throw new Error(res.error);
        if (!Array.isArray(res.files)) throw new Error(t('diff.errors.invalidResponse'));
        setData(res);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('diff.errors.loadFailed')))
      .finally(() => setLoading(false));
  }, [serverName, path, baseBranch, commit]);

  useEffect(() => {
    if (data && initialFile) {
      setActiveFile(initialFile);
      requestAnimationFrame(() => {
        const el = fileRefs.current.get(initialFile);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [data, initialFile]);

  const handleFileClick = useCallback((file: string) => {
    setActiveFile(file);
    const el = fileRefs.current.get(file);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--ws-surface)' }}>
        <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--font-md)', padding: 24 }}>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('diff.errors.loadTitle')}</div>
          <div style={{ color: 'var(--text-dim)' }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!data || !data.files || data.files.length === 0) {
    return <EmptyState title={t('diff.noChanges')} description={t('diff.noChangesDescription')} />;
  }

  const totalAdditions = data.files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = data.files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ws-surface)' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-card)',
          flexShrink: 0,
          flexWrap: 'wrap',
          minHeight: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <code style={{ fontSize: 'var(--font-sm)', color: 'var(--accent)' }}>{data.headBranch}</code>
          {data.baseBranch && data.baseBranch !== 'HEAD' && (
            <>
              <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>&larr;</span>
              <code style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{data.baseBranch}</code>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 'var(--font-sm)', marginLeft: 'auto' }}>
          {totalAdditions > 0 && (
            <span style={{ color: 'var(--success)', fontWeight: 600 }}>+{totalAdditions}</span>
          )}
          {totalDeletions > 0 && (
            <span style={{ color: 'var(--danger)', fontWeight: 600 }}>-{totalDeletions}</span>
          )}
          <span style={{ color: 'var(--text-dim)' }}>
            {t('diff.fileCount', { count: data.files.length })}
          </span>
          {data.truncated && (
            <span style={{ color: 'var(--warning)', fontSize: 'var(--font-xs)' }}>
              {t('diff.truncated')}
            </span>
          )}
        </div>
      </div>

      {/* Content: file list + diff */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* File list sidebar */}
        {fileListOpen ? (
          <div style={{ display: 'flex', flexShrink: 0 }}>
            <div
              style={{
                width: 'min(260px, 70vw)',
                minWidth: 'min(200px, 60vw)',
                maxWidth: 400,
                background: 'var(--bg-card)',
                borderRight: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <DiffFileList
                files={data.files}
                activeFile={activeFile}
                onFileClick={handleFileClick}
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
    </div>
  );
}
